export const fake = {
  accounts: [
    {id:'primary',status:'ACTIVE', toolkit:{slug:'slack'},alias:'primary@example.test'},
    {id:'alternate',status:'ACTIVE',toolkit:{slug:'slack'},alias:'alternate@example.test'},
  ], selected:'primary', outcome:{data:{ok:true}}, refreshStatus:'ACTIVE', redirect:null,
  calls:[], probes:false, metadataMissing:false,
};
export class ToolRouterSession {
 async search() { return {success:true,results:[{primaryToolSlugs:["GITHUB_GET_REPO"]}],toolSchemas:{GITHUB_GET_REPO:{toolkit:"github",inputSchema:{type:"object",properties:{},additionalProperties:false}}}}; }
 async toolkits() { const a=fake.accounts.find(a=>a.id===fake.selected); return {items: a ? [{slug:'slack',name:'Slack',connection:{isActive:a.status==='ACTIVE',connectedAccount:{id:a.id,status:a.status}}}] : []}; }
 async execute(slug,args,options) { fake.calls.push({slug,account:options?.account}); if(fake.outcome instanceof Error) throw fake.outcome; return fake.outcome; }
}
export class Composio {
 constructor() {
  this.client={};
  this.sessions={create:async()=>new ToolRouterSession()};
  this.tools={getRawComposioToolBySlug:async()=>{if(fake.metadataMissing)throw Error("not a standalone tool");return {toolkit:{slug:"slack"}};},execute:async()=>fake.probes ? {successful:true,data:{email:'primary@example.test'}} : {successful:false}};
  this.toolkits={get:async()=>[{slug:'slack',name:'Slack'}]};
  this.connectedAccounts={
   list:async(params)=>({items:fake.accounts.filter(a=>!params.toolkitSlugs || params.toolkitSlugs.includes(a.toolkit.slug))}),
   get:async(id)=>{const a=fake.accounts.find(a=>a.id===id);if(!a)throw Error('missing');return a;},
   refresh:async(id,options)=>{fake.calls.push({refresh:id,options}); return {id,status:fake.refreshStatus,redirect_url:fake.redirect};},
   delete:async(id)=>{fake.accounts=fake.accounts.filter(a=>a.id!==id);},
  };
 }
}
