'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const ROOT=__dirname, PORT=Number(process.env.PORT || 8765);
const sessions=new Map();
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg'};
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function body(req){return new Promise((resolve,reject)=>{let buf='';req.on('data',x=>{buf+=x;if(buf.length>1500000){reject(new Error('body too large'));req.destroy();}});req.on('end',()=>{try{resolve(JSON.parse(buf || '{}'));}catch(e){reject(e);}});req.on('error',reject);});}
function authenticated(req,id){const s=sessions.get(id);return s && req.headers.authorization==='Bearer '+s.token ? s : null;}
const server=http.createServer(async(req,res)=>{
  try {
    const host=req.headers.host;
    if(!['127.0.0.1:'+PORT,'localhost:'+PORT].includes(host)) return json(res,403,{error:'local host only'});
    const origin=req.headers.origin;
    if(origin && !['http://127.0.0.1:'+PORT,'http://localhost:'+PORT].includes(origin)) return json(res,403,{error:'origin rejected'});
    const u=new URL(req.url,'http://'+host), p=u.pathname;
    if(p==='/bridge/register' && req.method==='POST'){
      const id=crypto.randomUUID(),token=crypto.randomBytes(24).toString('hex');
      sessions.set(id,{token,state:null,commands:[],results:new Map(),updated:Date.now()});
      return json(res,201,{id,token});
    }
    if(p.startsWith('/bridge/') && req.method==='POST'){
      const b=await body(req), s=authenticated(req,b.id);
      if(!s) return json(res,401,{error:'invalid session or token'});
      if(p==='/bridge/sync'){
        s.state=b.state;s.updated=Date.now();
        return json(res,200,{commands:s.commands.splice(0)});
      }
      if(p==='/bridge/result'){
        s.results.set(b.requestId,b.result);
        if(s.results.size>200)s.results.delete(s.results.keys().next().value);
        return json(res,200,{ok:true});
      }
    }
    const match=p.match(/^\/api\/sessions\/([a-f0-9-]+)(?:\/(actions|results)(?:\/([a-f0-9-]+))?)?$/);
    // Local session discovery: lets an AI client (bot.mjs) attach to the
    // page that is currently in "AI 身份" mode. localhost-only by design.
    if(p==='/api/sessions' && req.method==='GET'){
      const now=Date.now();
      const list=[];
      for(const [id,s] of sessions)
        if(s.state && now-s.updated<10000) list.push({id,token:s.token,updated:s.updated,mode:s.state.mode,round:s.state.round,phase:s.state.phase});
      list.sort((a,b)=>b.updated-a.updated);
      return json(res,200,{sessions:list});
    }
    if(match){
      const s=authenticated(req,match[1]);
      if(!s)return json(res,401,{error:'invalid session or token'});
      if(!s.state || Date.now()-s.updated>10000)return json(res,409,{error:'AI page disconnected or inactive'});
      if(!match[2] && req.method==='GET')return json(res,200,s.state);
      if(match[2]==='actions' && req.method==='POST'){
        const command=await body(req);
        if(command.revision!==s.state.revision)return json(res,409,{error:'stale revision; read state again'});
        if(s.commands.length>=10)return json(res,429,{error:'queue full'});
        const requestId=crypto.randomUUID();s.commands.push({requestId,command});
        return json(res,202,{requestId,status:'queued'});
      }
      if(match[2]==='results' && req.method==='GET')return json(res,200,s.results.get(match[3]) || {status:'pending'});
      return json(res,405,{error:'method not allowed'});
    }
    if(req.method!=='GET' && req.method!=='HEAD')return json(res,405,{error:'method not allowed'});
    const rel=decodeURIComponent(p==='/'?'/index.html':p);
    // Serve only browser assets, never source-control files, tests or local scripts.
    if(!/^\/(index\.html|manifest\.webmanifest|sw\.js|(?:js|css|icons|assets|audio|vendor)\/[a-zA-Z0-9_./ -]+)$/.test(rel) || rel.split('/').includes('..') || rel.split('/').some(x=>x.startsWith('.')))return json(res,404,{error:'not found'});
    const file=path.resolve(ROOT,'.'+rel);
    if(!file.startsWith(ROOT+path.sep))return json(res,403,{error:'forbidden'});
    const stat=await fs.promises.stat(file).catch(()=>null);
    if(!stat || !stat.isFile())return json(res,404,{error:'not found'});
    res.writeHead(200,{'Content-Type':mime[path.extname(file)] || 'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    if(req.method==='HEAD')return res.end();
    fs.createReadStream(file).pipe(res);
  } catch(e){if(!res.headersSent)json(res,400,{error:e.message});else res.end();}
});
setInterval(()=>{for(const [id,s] of sessions)if(Date.now()-s.updated>3600000)sessions.delete(id);},60000).unref();
server.listen(PORT,'127.0.0.1',()=>console.log('DOUDIZHU READY http://127.0.0.1:'+PORT));
