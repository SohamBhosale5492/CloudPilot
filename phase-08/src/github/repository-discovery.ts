import type { PrismaClient } from "@prisma/client";
import type { GitHubAppAuthenticationCredentialProvider } from "./credential-provider.js";
import { createGitHubAppJwt } from "./app-token-service.js";
import { hasOrganizationPermission } from "../organizations/permissions.js";

export const DISCOVERY_TOKEN_PERMISSIONS = Object.freeze({ metadata: "read" } as const);
const API = "https://api.github.com";
const MAX_BYTES = 1_000_000;
const MAX_CACHE = 128;
const TTL_MARGIN = 60_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function readWithTimeout(reader:ReadableStreamDefaultReader<Uint8Array>,signal:AbortSignal):Promise<ReadableStreamReadResult<Uint8Array>>{
  if(signal.aborted)throw new RepositoryDiscoveryError("timeout");
  let onAbort!:()=>void;const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(new RepositoryDiscoveryError("timeout"));signal.addEventListener("abort",onAbort,{once:true});});
  try{return await Promise.race([reader.read(),aborted]);}catch(e){if(signal.aborted){await reader.cancel().catch(()=>{});throw new RepositoryDiscoveryError("timeout");}throw e;}finally{signal.removeEventListener("abort",onAbort);}
}

export type DiscoveryErrorCode = "credentials_unavailable" | "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "upstream_failure" | "timeout" | "network_failure" | "invalid_response";
export class RepositoryDiscoveryError extends Error {
  constructor(readonly code: DiscoveryErrorCode) { super("GitHub repository discovery could not be completed."); }
}
interface Token { value: string; expires: number }
/** Dedicated, in-memory, installation-only metadata token cache. Never exposes tokens outside backend code. */
export class MetadataInstallationTokenService {
  private cache = new Map<string, Token>();
  private pending = new Map<string, {generation:number; promise:Promise<Token>}>();
  private generations = new Map<string,number>();
  constructor(private credentials: GitHubAppAuthenticationCredentialProvider, private fetcher: typeof fetch = fetch, private now = Date.now) {}
  invalidate(id: string): void { this.generations.set(id,(this.generations.get(id)??0)+1); this.cache.delete(id); }
  async token(id: string): Promise<string> {
    const generation=this.generations.get(id)??0;
    const cached = this.cache.get(id);
    if (cached && cached.expires > this.now() + TTL_MARGIN) return cached.value;
    this.cache.delete(id);
    const existing = this.pending.get(id); if (existing?.generation===generation) return (await existing.promise).value;
    const task = this.mint(id).then(token=>{if((this.generations.get(id)??0)!==generation)throw new RepositoryDiscoveryError("invalid_response");if(token.expires<=this.now()+TTL_MARGIN)throw new RepositoryDiscoveryError("invalid_response");while(this.cache.size>=MAX_CACHE)this.cache.delete(this.cache.keys().next().value!);this.cache.set(id,token);return token;}).finally(() => {if(this.pending.get(id)?.promise===task)this.pending.delete(id);}); this.pending.set(id,{generation,promise:task});
    return (await task).value;
  }
  private async mint(id: string): Promise<Token> {
    let c; try { c = await this.credentials.getAppAuthenticationCredentials(); } catch { throw new RepositoryDiscoveryError("credentials_unavailable"); }
    const jwt = createGitHubAppJwt(c.appId, c.privateKeyPem, this.now());
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      let res: Response; try { res = await this.fetcher(`${API}/app/installations/${id}/access_tokens`, { method:"POST", redirect:"error", signal:controller.signal, headers:{Authorization:`Bearer ${jwt}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json"}, body:JSON.stringify({permissions:DISCOVERY_TOKEN_PERMISSIONS}) }); }
      catch { throw new RepositoryDiscoveryError(controller.signal.aborted ? "timeout" : "network_failure"); }
      if (!res.ok) { await res.body?.cancel(); throw new RepositoryDiscoveryError(res.status===401?"unauthorized":res.status===403?(res.headers.get("retry-after")?"rate_limited":"forbidden"):res.status===404?"not_found":"upstream_failure"); }
      const reader=res.body?.getReader(); if(!reader) throw new RepositoryDiscoveryError("invalid_response"); let bytes=0; const chunks:Uint8Array[]=[];
      try { for(;;){const x=await reader.read();if(x.done)break;bytes+=x.value.byteLength;if(bytes>MAX_BYTES){await reader.cancel();throw new RepositoryDiscoveryError("invalid_response");}chunks.push(x.value);} } catch(e){if(e instanceof RepositoryDiscoveryError)throw e;throw new RepositoryDiscoveryError(controller.signal.aborted?"timeout":"network_failure");}
      const data=JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as {token?:unknown;expires_at?:unknown;permissions?:unknown};
      const exp=typeof data.expires_at==="string"?Date.parse(data.expires_at):NaN;
      if(typeof data.token!=="string"||!data.token||!Number.isFinite(exp)||exp<=this.now()+TTL_MARGIN||JSON.stringify(data.permissions)!==JSON.stringify(DISCOVERY_TOKEN_PERMISSIONS)) throw new RepositoryDiscoveryError("invalid_response");
      return {value:data.token,expires:exp};
    } catch(e){if(e instanceof RepositoryDiscoveryError)throw e;throw new RepositoryDiscoveryError("invalid_response");} finally{clearTimeout(timer);}
  }
}

export interface RepositoryMetadata { id:string; owner:string; name:string; fullName:string; private:boolean; defaultBranch:string|null; archived:boolean; disabled:boolean }
export class GitHubInstallationRepositoryClient {
  constructor(private tokens:MetadataInstallationTokenService,private fetcher:typeof fetch=fetch,private timeoutMs=10_000){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120_000)throw new Error("Repository discovery timeout is invalid.");}
  async list(installationId:string,page:number,perPage:number):Promise<{repositories:RepositoryMetadata[];hasNextPage:boolean}> {
    const token=await this.tokens.token(installationId);const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try{let response:Response;try{response=await this.fetcher(`${API}/installation/repositories?per_page=${perPage}&page=${page}`,{redirect:"error",signal:controller.signal,headers:{Authorization:`Bearer ${token}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"}});}catch{throw new RepositoryDiscoveryError(controller.signal.aborted?"timeout":"network_failure");}
      if(!response.ok){await response.body?.cancel();if(response.status===401)this.tokens.invalidate(installationId);throw new RepositoryDiscoveryError(response.status===401?"unauthorized":response.status===403?(response.headers.get("retry-after")?"rate_limited":"forbidden"):response.status===404?"not_found":"upstream_failure");}
      const reader=response.body?.getReader();if(!reader)throw new RepositoryDiscoveryError("invalid_response");let n=0;const parts:Uint8Array[]=[];try{for(;;){const x=await readWithTimeout(reader,controller.signal);if(x.done)break;n+=x.value.byteLength;if(n>MAX_BYTES){await reader.cancel();throw new RepositoryDiscoveryError("invalid_response");}parts.push(x.value);}}catch(e){if(e instanceof RepositoryDiscoveryError)throw e;throw new RepositoryDiscoveryError(controller.signal.aborted?"timeout":"network_failure");}
      const body=JSON.parse(new TextDecoder().decode(Buffer.concat(parts))) as {repositories?:unknown};if(!Array.isArray(body.repositories))throw new RepositoryDiscoveryError("invalid_response");const seen=new Set<string>();const repositories:RepositoryMetadata[]=[];
      for(const x of body.repositories){if(!x||typeof x!=="object")throw new RepositoryDiscoveryError("invalid_response");const r=x as Record<string,unknown>;const id=typeof r.id==="string"&&/^\d+$/.test(r.id)?r.id:typeof r.id==="number"&&Number.isSafeInteger(r.id)&&r.id>0?String(r.id):null;const owner=r.owner&&typeof r.owner==="object"?(r.owner as Record<string,unknown>).login:null;if(!id||!/^\d+$/.test(id)||typeof owner!=="string"||!owner||typeof r.name!=="string"||!r.name||typeof r.full_name!=="string"||typeof r.private!=="boolean"||typeof r.archived!=="boolean"||(r.disabled!==undefined&&typeof r.disabled!=="boolean")||(r.default_branch!==undefined&&typeof r.default_branch!=="string"))throw new RepositoryDiscoveryError("invalid_response");if(seen.has(id))continue;seen.add(id);repositories.push({id,owner,name:r.name,fullName:r.full_name,private:r.private,defaultBranch:(r.default_branch as string|undefined)??null,archived:r.archived,disabled:(r.disabled as boolean|undefined)??false});}
      const links=response.headers.get("link")??"";return{repositories,hasNextPage:/rel="next"/.test(links)};
    }catch(e){if(e instanceof RepositoryDiscoveryError)throw e;throw new RepositoryDiscoveryError("invalid_response");}finally{clearTimeout(timer);}
  }
  async verifyRepository(installationId:string,repositoryId:string):Promise<RepositoryMetadata|null>{
    if(!/^\d{1,19}$/.test(repositoryId))throw new RepositoryDiscoveryError("invalid_response");
    for(let page=1;page<=10;page++){const result=await this.list(installationId,page,100);const match=result.repositories.find(r=>r.id===repositoryId);if(match)return match;if(!result.hasNextPage)return null;}return null;
  }
}

export class PrismaInstallationDiscoveryAuthorization {
  constructor(private prisma:PrismaClient){}
  async installations(userId:string,orgId:string){const m=await this.prisma.organizationMember.findFirst({where:{organizationId:orgId,userId,status:"active",user:{is:{status:"active"}},organization:{is:{status:"active"}}},select:{role:true}});if(!m||!hasOrganizationPermission(m.role,"organization:integrations"))return null;return this.prisma.organizationGitHubInstallation.findMany({where:{organizationId:orgId,status:"active",organization:{is:{status:"active"}}},select:{id:true,githubAccountLogin:true,githubAccountType:true,status:true,createdAt:true},orderBy:{createdAt:"asc"}});}
  async resolve(userId:string,orgId:string,recordId:string){if(!uuid.test(orgId)||!uuid.test(recordId))return null;const m=await this.prisma.organizationMember.findFirst({where:{organizationId:orgId,userId,status:"active",user:{is:{status:"active"}},organization:{is:{status:"active"}}},select:{role:true}});if(!m||!hasOrganizationPermission(m.role,"organization:integrations"))return null;return this.prisma.organizationGitHubInstallation.findFirst({where:{id:recordId,organizationId:orgId,status:"active",organization:{is:{status:"active"}}},select:{githubInstallationId:true}});}
}
