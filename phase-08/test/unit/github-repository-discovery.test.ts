import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { GitHubInstallationRepositoriesApi } from "../../src/api/github-installation-repositories-api.js";
import type { AuthenticatedRouteContext } from "../../../phase-06/src/api/server.js";
import { DISCOVERY_TOKEN_PERMISSIONS, GitHubInstallationRepositoryClient, MetadataInstallationTokenService, RepositoryDiscoveryError } from "../../src/github/repository-discovery.js";

function provider(){const p=generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{type:"pkcs8",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}});return {async getAppAuthenticationCredentials(){return {appId:22,privateKeyPem:p.privateKey};}};}
test("discovery token requests exactly metadata read and coalesces per installation",async()=>{let calls=0;const fetcher=(async(_u,init)=>{calls++;assert.deepEqual(JSON.parse(String(init?.body)),{permissions:{metadata:"read"}});return new Response(JSON.stringify({token:"opaque-token",expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{metadata:"read"}}),{status:201});}) as typeof fetch;const service=new MetadataInstallationTokenService(provider(),fetcher);const [a,b]=await Promise.all([service.token("42"),service.token("42")]);assert.equal(a,b);assert.equal(calls,1);assert.deepEqual(DISCOVERY_TOKEN_PERMISSIONS,{metadata:"read"});assert.equal(Object.keys(DISCOVERY_TOKEN_PERMISSIONS).some(x=>["contents","pull_requests","workflows","administration"].includes(x)),false);});
test("repository listing validates, deduplicates IDs and uses fixed numeric pagination",async()=>{let url="";const fetcher=(async(input,init)=>{url=String(input);assert.equal((init?.headers as Record<string,string>).Authorization,"Bearer opaque-token");return new Response(JSON.stringify({repositories:[{id:9007199254740993n.toString(),name:"api",full_name:"org/api",owner:{login:"org"},private:true,archived:false,default_branch:"main"},{id:"9007199254740993",name:"api",full_name:"org/api",owner:{login:"org"},private:true,archived:false,default_branch:"main"}]}),{headers:{link:'<https://api.github.com/installation/repositories?page=2>; rel="next"'}});}) as typeof fetch;const tokens=new MetadataInstallationTokenService(provider(),(async()=>new Response(JSON.stringify({token:"opaque-token",expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{metadata:"read"}}),{status:201})) as typeof fetch);const result=await new GitHubInstallationRepositoryClient(tokens,fetcher).list("42",1,30);assert.match(url,/^https:\/\/api\.github\.com\/installation\/repositories\?per_page=30&page=1$/);assert.equal(result.repositories.length,1);assert.equal(result.repositories[0].id,"9007199254740993");assert.equal(result.hasNextPage,true);});
test("invalid token permission response fails closed",async()=>{const s=new MetadataInstallationTokenService(provider(),(async()=>new Response(JSON.stringify({token:"x",expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{metadata:"read",contents:"write"}}),{status:201})) as typeof fetch);await assert.rejects(s.token("1"),(e:unknown)=>e instanceof RepositoryDiscoveryError&&e.code==="invalid_response");});

test("cache hit, expiry refresh, installation isolation, and invalidation fencing",async()=>{
 let now=Date.now(),calls=0,release!: (r:Response)=>void;const delayed=new Promise<Response>(resolve=>release=resolve);
 const fetcher=(async()=>{calls++;if(calls===1)return delayed;return new Response(JSON.stringify({token:`token-${calls}`,expires_at:new Date(now+3_600_000).toISOString(),permissions:{metadata:"read"}}),{status:201});}) as typeof fetch;
 const svc=new MetadataInstallationTokenService(provider(),fetcher,()=>now);
 const pending=svc.token("71");svc.invalidate("71");release(new Response(JSON.stringify({token:"stale",expires_at:new Date(now+3_600_000).toISOString(),permissions:{metadata:"read"}}),{status:201}));
 await assert.rejects(pending);const fresh=await svc.token("71");assert.equal(fresh,"token-2");assert.equal(await svc.token("71"),fresh);assert.notEqual(await svc.token("72"),fresh);
 now+=3_600_001;assert.notEqual(await svc.token("71"),fresh);assert.equal(calls,4);
});

test("organization authorization scopes membership and installation to the same organization",async()=>{
 const calls:unknown[]=[];let role="viewer",memberStatus="active",installationOrg="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",installStatus="active";
 const prisma={organizationMember:{async findFirst(a:unknown){calls.push(a);return memberStatus==="active"?{role}:null;}},organizationGitHubInstallation:{async findMany(a:unknown){calls.push(a);return []},async findFirst(a:unknown){calls.push(a);return installationOrg==="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"&&installStatus==="active"?{githubInstallationId:42n}:null;}}};
 const auth=new (await import("../../src/github/repository-discovery.js")).PrismaInstallationDiscoveryAuthorization(prisma as never);
 assert.deepEqual(await auth.resolve("u","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","11111111-1111-4111-8111-111111111111"),{githubInstallationId:42n});
 assert.deepEqual(await auth.installations("u","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),[]);role="operator";assert.ok(await auth.resolve("u","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","11111111-1111-4111-8111-111111111111"));
 role="bad";assert.equal(await auth.resolve("u","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","11111111-1111-4111-8111-111111111111"),null);
 role="admin";memberStatus="inactive";assert.equal(await auth.resolve("u","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","11111111-1111-4111-8111-111111111111"),null);
 memberStatus="active";installationOrg="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";assert.equal(await auth.resolve("u","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","11111111-1111-4111-8111-111111111111"),null);
 installationOrg="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";installStatus="disconnected";assert.equal(await auth.resolve("u","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","11111111-1111-4111-8111-111111111111"),null);
 const where=(calls.at(-1) as {where:{organizationId:string;id:string}}).where;assert.equal(where.organizationId,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");assert.equal(where.id,"11111111-1111-4111-8111-111111111111");
});

test("repository discovery maps upstream failures safely and rejects malformed metadata",async()=>{
 const tokenFetch=(async()=>new Response(JSON.stringify({token:"opaque",expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{metadata:"read"}}),{status:201})) as typeof fetch;
 for(const [status,code] of [[401,"unauthorized"],[403,"forbidden"],[404,"not_found"],[503,"upstream_failure"]] as const){const svc=new MetadataInstallationTokenService(provider(),tokenFetch);const client=new GitHubInstallationRepositoryClient(svc,(async()=>new Response("private upstream detail",{status})) as typeof fetch);await assert.rejects(client.list("9",1,30),(e:unknown)=>e instanceof RepositoryDiscoveryError&&e.code===code);}
 const malformed=new GitHubInstallationRepositoryClient(new MetadataInstallationTokenService(provider(),tokenFetch),(async()=>new Response(JSON.stringify({repositories:[{id:3,name:"bad"}]}))) as typeof fetch);await assert.rejects(malformed.list("9",1,30),(e:unknown)=>e instanceof RepositoryDiscoveryError&&e.code==="invalid_response");
});

test("route applies pagination defaults and limits before discovery; identity failure never calls GitHub",async()=>{
 const org="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",record="11111111-1111-4111-8111-111111111111";const calls:unknown[]=[];let identityFails=false;
 const ids={async resolve(){if(identityFails)throw new Error("no local identity");return{id:"local"};}} as never;
 const auth={async installations(){return[];},async resolve(...args:unknown[]){calls.push(args);return{githubInstallationId:42n};}} as never;
 const gh={async list(...args:unknown[]){calls.push(args);return{repositories:[],hasNextPage:false};}} as never;
 const api=new GitHubInstallationRepositoriesApi(ids,auth,gh,{expectedIssuer:"https://issuer",allowFirstUseProvisioning:false});
 const run=async(path:string)=>{let status=0,body:unknown;const parsed=new URL(`http://localhost${path}`);const c={method:"GET",pathname:parsed.pathname,url:parsed,identity:{userId:"subject",tenantId:"t",roles:[]},sendJson(s:number,b:unknown){status=s;body=b;}} as unknown as AuthenticatedRouteContext;await api.handle(c);return{status,body};};
 assert.equal((await run(`/api/v1/organizations/${org}/github/installations/${record}/repositories`)).status,200);assert.deepEqual(calls.pop(),["42",1,30]);
 for(const q of ["page=0","page=11","page=-1","page=1.5","page=abc","page=999999999","perPage=0","perPage=101","perPage=1.1","perPage=no","page=1&page=2"]){assert.equal((await run(`/api/v1/organizations/${org}/github/installations/${record}/repositories?${q}`)).status,400,q);}
 assert.equal((await run(`/api/v1/organizations/${org}/github/installations/${record}/repositories?page=10&perPage=100`)).status,200);assert.deepEqual(calls.pop(),["42",10,100]);
 calls.length=0;identityFails=true;assert.equal((await run(`/api/v1/organizations/${org}/github/installations/${record}/repositories`)).status,503);assert.equal(calls.length,0);
});

test("route caps discovery at 1000, supports boundary values, and returns no secret material",async()=>{
 const org="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",record="11111111-1111-4111-8111-111111111111";const gitCalls:unknown[]=[];
 const api=new GitHubInstallationRepositoriesApi({async resolve(){return{id:"local"};}} as never,{async resolve(){return{githubInstallationId:42n};},async installations(){return[];}} as never,{async list(_id:string,page:number,size:number){gitCalls.push([page,size]);return{repositories:[],hasNextPage:true};}} as never,{expectedIssuer:"issuer",allowFirstUseProvisioning:false});
 const request=async(path:string)=>{let status=0,body:unknown;const url=new URL(`http://localhost${path}`);await api.handle({method:"GET",pathname:url.pathname,url,identity:{userId:"subject",tenantId:"t",roles:[]},sendJson(s:number,b:unknown){status=s;body=b;}} as never);return{status,body};};
 for(const [q,p,n] of [["page=1&perPage=1",1,1],["page=10&perPage=100",10,100]] as const){const res=await request(`/api/v1/organizations/${org}/github/installations/${record}/repositories?${q}`);assert.equal(res.status,200);assert.deepEqual(gitCalls.pop(),[p,n]);const body=res.body as {hasNextPage:boolean};assert.equal(body.hasNextPage,p*n<1000&&p<10);assert.doesNotMatch(JSON.stringify(res.body),/token|private.?key|authorization|secret/i);}
 const errorApi=new GitHubInstallationRepositoriesApi({async resolve(){return{id:"local"};}} as never,{async resolve(){return{githubInstallationId:42n};},async installations(){return[];}} as never,{async list(){throw new RepositoryDiscoveryError("upstream_failure");}} as never,{expectedIssuer:"issuer",allowFirstUseProvisioning:false});
 let errorBody:unknown;const url=new URL(`http://localhost/api/v1/organizations/${org}/github/installations/${record}/repositories`);await errorApi.handle({method:"GET",pathname:url.pathname,url,identity:{userId:"s",tenantId:"t",roles:[]},sendJson(_s:number,b:unknown){errorBody=b;}} as never);assert.doesNotMatch(JSON.stringify(errorBody),/private upstream|token|authorization|secret/i);
});

test("discovery client safely handles stalled, oversized, malformed, and network responses",async()=>{
 const tokenFetch=(async()=>new Response(JSON.stringify({token:"opaque",expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{metadata:"read"}}),{status:201})) as typeof fetch;
 const make=(fetcher:typeof fetch)=>new GitHubInstallationRepositoryClient(new MetadataInstallationTokenService(provider(),tokenFetch),fetcher);
 await assert.rejects(make((async()=>{throw new Error("raw secret network failure");}) as typeof fetch).list("3",1,30),(e:unknown)=>e instanceof RepositoryDiscoveryError&&e.code==="network_failure");
 await assert.rejects(make((async()=>new Response("not json")) as typeof fetch).list("3",1,30),(e:unknown)=>e instanceof RepositoryDiscoveryError&&e.code==="invalid_response");
 await assert.rejects(make((async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1_000_001));c.close();}}))) as typeof fetch).list("3",1,30),(e:unknown)=>e instanceof RepositoryDiscoveryError&&e.code==="invalid_response");
 let signal:AbortSignal|undefined;const stalled=(async(_u:RequestInfo|URL,init?:RequestInit)=>{signal=init?.signal??undefined;return new Response(new ReadableStream({start(){}}));}) as typeof fetch;
 const timed=new GitHubInstallationRepositoryClient(new MetadataInstallationTokenService(provider(),tokenFetch),stalled,15);
 await assert.rejects(timed.list("3",1,30),(e:unknown)=>e instanceof RepositoryDiscoveryError&&e.code==="timeout");assert.equal(signal?.aborted,true);
});
