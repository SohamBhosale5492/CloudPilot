import { Prisma, PrismaClient } from "@prisma/client";
import { hasOrganizationPermission } from "./permissions.js";
import { GitHubInstallationRepositoryClient, RepositoryDiscoveryError } from "../github/repository-discovery.js";

export class ProjectGitHubBindingError extends Error { constructor(readonly code:"not_found"|"forbidden"|"conflict"|"invalid"|"unavailable"){super(code);} }
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID=/^[1-9]\d{0,18}$/;
function isConflict(e:unknown):boolean{return e instanceof Prisma.PrismaClientKnownRequestError&&(e.code==="P2002"||e.code==="P2034");}

export class ProjectGitHubBindingService {
  constructor(private prisma:PrismaClient,private github:GitHubInstallationRepositoryClient){}
  async bind(input:{identityUserId:string;tenantId:string;organizationId:string;projectId:string;installationRecordId:string;repositoryId:string}){
    if(!UUID.test(input.organizationId)||!UUID.test(input.installationRecordId)||!ID.test(input.repositoryId))throw new ProjectGitHubBindingError("invalid");
    const context=await this.authorize(input,"organization:integrations:manage");
    let repo;try{repo=await this.github.verifyRepository(String(context.installation.githubInstallationId),input.repositoryId);}catch(e){if(e instanceof RepositoryDiscoveryError)throw new ProjectGitHubBindingError("unavailable");throw e;}
    if(!repo)throw new ProjectGitHubBindingError("not_found");
    try{return await this.prisma.$transaction(async tx=>{
      const fresh=await this.authorize(input,"organization:integrations:manage",tx);
      if(fresh.installation.githubInstallationId!==context.installation.githubInstallationId)throw new ProjectGitHubBindingError("conflict");
      const binding=await tx.projectGitHubRepository.create({data:{tenantId:input.tenantId,organizationId:input.organizationId,projectId:input.projectId,installationRecordId:input.installationRecordId,githubRepositoryId:BigInt(repo.id),ownerLogin:repo.owner,repositoryName:repo.name,connectedByIdentityUserId:input.identityUserId,status:"active"},select:{id:true,tenantId:true,organizationId:true,projectId:true,installationRecordId:true,githubRepositoryId:true,ownerLogin:true,repositoryName:true,status:true,createdAt:true}});
      await tx.organizationAuditEvent.create({data:{organizationId:input.organizationId,tenantId:input.tenantId,projectId:input.projectId,actorType:"user",actorUserId:input.identityUserId,action:"GITHUB_REPOSITORY_BOUND",targetType:"project_github_repository",targetId:binding.id,metadata:{projectId:input.projectId,installationRecordId:input.installationRecordId,repositoryId:repo.id,owner:repo.owner,name:repo.name} as Prisma.InputJsonValue},select:{id:true}});
      return binding;
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});}catch(e){if(e instanceof ProjectGitHubBindingError)throw e;if(isConflict(e))throw new ProjectGitHubBindingError("conflict");throw e;}
  }
  async current(input:{identityUserId:string;tenantId:string;organizationId:string;projectId:string}){
    if(!UUID.test(input.organizationId))throw new ProjectGitHubBindingError("not_found");await this.authorize(input,"organization:integrations");
    const row=await this.prisma.projectGitHubRepository.findFirst({where:{tenantId:input.tenantId,organizationId:input.organizationId,projectId:input.projectId,status:"active"},select:{id:true,installationRecordId:true,githubRepositoryId:true,ownerLogin:true,repositoryName:true,status:true,createdAt:true,updatedAt:true}});return row;
  }
  async disconnect(input:{identityUserId:string;tenantId:string;organizationId:string;projectId:string}){
    if(!UUID.test(input.organizationId))throw new ProjectGitHubBindingError("not_found");await this.authorize(input,"organization:integrations:manage");
    try{return await this.prisma.$transaction(async tx=>{
      await this.authorize(input,"organization:integrations:manage",tx);
      const row=await tx.projectGitHubRepository.findFirst({where:{tenantId:input.tenantId,organizationId:input.organizationId,projectId:input.projectId,status:"active"},select:{id:true,githubRepositoryId:true,ownerLogin:true,repositoryName:true}});
      if(!row)throw new ProjectGitHubBindingError("not_found");
      const now=new Date();
      const updated=await tx.projectGitHubRepository.updateMany({where:{id:row.id,tenantId:input.tenantId,organizationId:input.organizationId,projectId:input.projectId,status:"active"},data:{status:"disconnected",disconnectedAt:now}});
      if(updated.count!==1)throw new ProjectGitHubBindingError("conflict");

      // Approval is tied to this immutable binding. Preserve the decision fields
      // as history, but invalidate pending/approved proposals in the same transaction.
      const proposals=await tx.$queryRaw<Array<{id:string;plan_hash:string|null}>>`
        SELECT id, plan_hash FROM remediations
        WHERE repository_binding_id=${row.id}::uuid AND approval_state IN ('pending','approved')
        FOR UPDATE
      `;
      if(proposals.length){
        const invalidated=await tx.$queryRaw<Array<{id:string}>>`
          UPDATE remediations SET approval_state='invalidated', invalidated_by_identity_user_id=${input.identityUserId}::uuid,
            invalidated_at=${now}, updated_at=${now}
          WHERE id IN (${Prisma.join(proposals.map((p)=>Prisma.sql`${p.id}::uuid`))})
            AND repository_binding_id=${row.id}::uuid AND approval_state IN ('pending','approved')
          RETURNING id
        `;
        if(invalidated.length!==proposals.length)throw new ProjectGitHubBindingError("conflict");
        for(const proposal of proposals)await tx.organizationAuditEvent.create({data:{
          organizationId:input.organizationId,tenantId:input.tenantId,projectId:input.projectId,
          actorType:"user",actorUserId:input.identityUserId,action:"REMEDIATION_PROPOSAL_INVALIDATED",
          targetType:"remediation",targetId:proposal.id,
          metadata:{reason:"repository_binding_disconnected",repositoryBindingId:row.id,planHash:proposal.plan_hash} as Prisma.InputJsonValue
        },select:{id:true}});
      }
      await tx.organizationAuditEvent.create({data:{organizationId:input.organizationId,tenantId:input.tenantId,projectId:input.projectId,actorType:"user",actorUserId:input.identityUserId,action:"GITHUB_REPOSITORY_DISCONNECTED",targetType:"project_github_repository",targetId:row.id,metadata:{repositoryId:String(row.githubRepositoryId),owner:row.ownerLogin,name:row.repositoryName} as Prisma.InputJsonValue},select:{id:true}});
      return{id:row.id,status:"disconnected" as const};
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});}catch(e){if(e instanceof ProjectGitHubBindingError)throw e;if(isConflict(e))throw new ProjectGitHubBindingError("conflict");throw e;}
  }
  private async authorize(input:{identityUserId:string;tenantId:string;organizationId:string;projectId:string;installationRecordId?:string},permission:"organization:integrations"|"organization:integrations:manage",tx:Prisma.TransactionClient|PrismaClient=this.prisma){
    const membership=await tx.organizationMember.findFirst({where:{organizationId:input.organizationId,userId:input.identityUserId,status:"active",user:{is:{status:"active"}},organization:{is:{status:"active"}}},select:{role:true}});if(!membership||!hasOrganizationPermission(membership.role,permission))throw new ProjectGitHubBindingError("not_found");
    const project=await tx.project.findFirst({where:{id:input.projectId,tenantId:input.tenantId,organizationId:input.organizationId},select:{id:true}});if(!project)throw new ProjectGitHubBindingError("not_found");
    const adoption=await tx.projectOrganizationAdoption.findFirst({where:{tenantId:input.tenantId,organizationId:input.organizationId,projectId:input.projectId,status:"approved"},select:{id:true}});if(!adoption)throw new ProjectGitHubBindingError("not_found");
    let installation:{githubInstallationId:bigint;status:string}|null=null;if(input.installationRecordId){installation=await tx.organizationGitHubInstallation.findFirst({where:{id:input.installationRecordId,organizationId:input.organizationId},select:{githubInstallationId:true,status:true}});if(!installation||installation.status!=="active")throw new ProjectGitHubBindingError("not_found");}
    return {installation:installation!};
  }
}
