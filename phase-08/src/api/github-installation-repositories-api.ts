import type { AuthenticatedRouteContext, AuthenticatedRouteExtension } from "../../../phase-06/src/api/server.js";
import type { IdentityResolver } from "../identity/identity-resolver.js";
import type { VerifiedExternalIdentity } from "../identity/external-identity.js";
import { PrismaInstallationDiscoveryAuthorization, GitHubInstallationRepositoryClient, RepositoryDiscoveryError } from "../github/repository-discovery.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class GitHubInstallationRepositoriesApi implements AuthenticatedRouteExtension {
  constructor(private identities:IdentityResolver,private auth:PrismaInstallationDiscoveryAuthorization,private github:GitHubInstallationRepositoryClient,private options:{expectedIssuer:string;allowFirstUseProvisioning:boolean}){}
  async handle(c:AuthenticatedRouteContext):Promise<boolean>{
    const list=c.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/github\/installations$/);
    const repos=c.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/github\/installations\/([^/]+)\/repositories$/);
    if(c.method!=="GET"||(!list&&!repos))return false;
    const orgId=decodeURIComponent((list??repos)![1]);if(!UUID.test(orgId)){c.sendJson(404,{error:"Organization not found."});return true;}
    try{
      const identity=await this.identities.resolve({issuer:this.options.expectedIssuer,subject:c.identity.userId} as VerifiedExternalIdentity,this.options.allowFirstUseProvisioning);
      if(list){const rows=await this.auth.installations(identity.id,orgId);if(!rows){c.sendJson(404,{error:"Organization not found."});return true;}c.sendJson(200,{installations:rows.map(x=>({id:x.id,accountLogin:x.githubAccountLogin,accountType:x.githubAccountType,status:x.status,connectedAt:x.createdAt.toISOString()}))});return true;}
      const recordId=decodeURIComponent(repos![2]);if(!UUID.test(recordId)){c.sendJson(404,{error:"Installation not found."});return true;}
      const pageParam=c.url.searchParams.getAll("page"),sizeParam=c.url.searchParams.getAll("perPage");
      if(pageParam.length>1||sizeParam.length>1){c.sendJson(400,{error:"Pagination parameters are invalid."});return true;}
      const parse=(v:string|undefined,d:number,max:number)=>{if(v===undefined)return d;if(!/^[1-9]\d*$/.test(v))return null;const n=Number(v);return Number.isSafeInteger(n)&&n<=max?n:null;};
      const page=parse(pageParam[0],1,10),perPage=parse(sizeParam[0],30,100);if(page===null||perPage===null){c.sendJson(400,{error:"Pagination parameters are invalid."});return true;}
      const installation=await this.auth.resolve(identity.id,orgId,recordId);if(!installation){c.sendJson(404,{error:"Installation not found."});return true;}
      const result=await this.github.list(String(installation.githubInstallationId),page,perPage);c.sendJson(200,{...result,page,perPage,hasNextPage:page<10&&page*perPage<1000&&result.hasNextPage});return true;
    }catch(e){if(e instanceof RepositoryDiscoveryError){const status=e.code==="unauthorized"?502:e.code==="forbidden"?403:e.code==="not_found"?404:e.code==="rate_limited"?429:e.code==="timeout"?504:503;c.sendJson(status,{error:"GitHub repository discovery is unavailable."});return true;}c.sendJson(503,{error:"GitHub repository discovery is unavailable."});return true;}
  }
}
