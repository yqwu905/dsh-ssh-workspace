/** Boot the published DSH Web profile with this built plugin and exercise its trust fence/API. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot';

const home=await mkdtemp(join(tmpdir(),'dsh-ssh-web-smoke-'));
const dir=join(home,'profiles/web');
initProfile(dir,PROFILE_TEMPLATES.web.bundles);
const manifest=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
manifest.dependencies={'dsh-ssh-workspaces':`file:${resolve('.')}`};
manifest.dsh.profile.bundles.push('dsh-ssh-workspaces');
await writeFile(join(dir,'package.json'),JSON.stringify(manifest));
await mkdir(join(dir,'node_modules'),{recursive:true});
await symlink(resolve('.'),join(dir,'node_modules/dsh-ssh-workspaces'));
await writeFile(join(dir,'cordis.patch.yml'),`- id: ssh-workspaces\n  config:\n    stateDir: ${home}/ssh-state\n    mountRoot: ${home}/ssh-mounts\n`);
const child=spawn(process.execPath,['node_modules/@deepseek-ai/dsh/lib/bin.js','web','--no-open','--host','127.0.0.1','--port','0'],{env:{...process.env,DSH_HOME:home},stdio:['ignore','pipe','pipe']});
const closed=new Promise(resolve=>child.once('close',resolve));
let output='';
let timer;
try {
  const url=await new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(new Error('Web startup timed out: '+output.replace(/token=[^\s]+/g,'token=REDACTED'))),45000);
    const onData=chunk=>{
      output+=chunk.toString();
      const found=output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
      if(found){clearTimeout(timer);resolve(found[1]);}
    };
    child.stdout.on('data',onData);child.stderr.on('data',onData);
    child.once('error',reject);child.once('close',code=>reject(new Error(`Web exited (${code}): ${output.replace(/token=[^\s]+/g,'token=REDACTED')}`)));
  });
  const base=new URL(url).origin;
  const unauth=await fetch(base+'/api/ssh-workspaces');assert.equal(unauth.status,401);
  const login=await fetch(url,{redirect:'manual'});
  const cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie,'login cookie');
  const headers={cookie,origin:base,'content-type':'application/json'};
  const state=await fetch(base+'/api/ssh-workspaces',{headers});assert.equal(state.status,200);
  assert.deepEqual(await state.json(),{servers:[],workspaces:[]});
  assert.equal((await fetch(base+'/api/ssh-workspaces',{headers:{...headers,origin:'https://untrusted.invalid'}})).status,403);
  assert.equal((await fetch(base+'/api/ssh-workspaces/ssh-config')).status,401);
  const config=await fetch(base+'/api/ssh-workspaces/ssh-config',{headers});assert.equal(config.status,200);
  const aliases=await config.json();assert.ok(Array.isArray(aliases.hosts));
  const auto=await fetch(base+'/api/ssh-workspaces/servers',{method:'POST',headers,body:JSON.stringify({label:'auto-test',host:'auto-not-connected'})});
  assert.equal(auto.status,200,await auto.clone().text());
  const autoState=await auto.json();assert.equal(autoState.servers[0].helperMode,'auto');assert.equal(autoState.servers[0].helper,undefined);
  assert.equal((await fetch(base+'/api/ssh-workspaces/servers/'+autoState.servers[0].id,{method:'DELETE',headers})).status,200);
  const create=await fetch(base+'/api/ssh-workspaces/servers',{method:'POST',headers,body:JSON.stringify({label:'test-only',host:'test-not-connected',helper:'/opt/dsh/helper',helperHash:'0'.repeat(64),launch:{kind:'executable'}})});
  assert.equal(create.status,200,await create.clone().text());
  const created=await create.json();assert.equal(created.servers.length,1);
  const remove=await fetch(base+'/api/ssh-workspaces/servers/'+created.servers[0].id,{method:'DELETE',headers});assert.equal(remove.status,200);
  const html=await(await fetch(base+'/',{headers})).text();
  assert.ok(html.includes('dsh-ssh-workspaces'),'client module appears in boot payload');
  console.log('PASS DSH 0.2.1-rc.2 Web startup, native auth/origin fence, server CRUD, and browser module discovery.');
} finally {
  clearTimeout(timer);child.kill('SIGTERM');
  const kill=setTimeout(()=>child.kill('SIGKILL'),5000);
  await closed;clearTimeout(kill);await rm(home,{recursive:true,force:true});
}
