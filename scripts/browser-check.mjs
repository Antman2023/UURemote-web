import { chromium } from 'playwright-core';
import { mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let executablePath;
for (const candidate of candidates) { try { await access(candidate); executablePath=candidate; break; } catch {} }
if (!executablePath) throw new Error('Set CHROME_PATH to a local Chrome/Chromium executable.');
const output=resolve('.local/screenshots'); await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath,headless:true});
const errors=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:5173');
  await page.waitForFunction(()=>document.querySelector('#account-label')?.textContent==='登录账号');
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await page.evaluate(()=>[...document.images].some(i=>i.complete && !i.naturalWidth)),false);
  await page.screenshot({path:resolve(output,'home-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'更多设置'}).click();
  await page.getByRole('combobox',{name:'显示分辨率'}).selectOption('2560x1440');
  await page.getByRole('combobox',{name:'视频帧率'}).selectOption('30');
  await page.getByRole('button',{name:'保存设置'}).click();
  assert.match(await page.locator('#quality-label').textContent(),/1440P/);
  await page.reload();assert.match(await page.locator('#fps-label').textContent(),/30 FPS/);
  await page.getByRole('button',{name:'操作指南'}).click();
  await page.getByRole('button',{name:'键鼠操作',exact:true}).click();
  assert.match(await page.locator('#modal').textContent(),/Esc/);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#modal').evaluate(e=>e.open),false);
  await page.getByRole('button',{name:'登录账号'}).click();
  assert.equal(await page.getByRole('button',{name:'生成登录二维码'}).count(),1);
  await page.getByRole('button',{name:'使用已有登录令牌'}).click();
  assert.equal(await page.locator('input[name=token]').getAttribute('type'),'password');
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:resolve(output,'home-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.setViewportSize({width:1440,height:1000});

  // Authenticated UI fixture only: it never contacts UU, logs in, or starts a real remote session.
  await page.route('**/api/status',route=>route.fulfill({json:{ready:true,authenticated:true,user:{nickname:'浏览器测试'}}}));
  await page.route('**/api/devices',route=>route.fulfill({json:{my_binded_devices:[{device_id:'test-pc',alias:'我的电脑',status:'online',platform:3,version_name:'3.5.0'},{device_id:'offline-pc',alias:'离线电脑',status:'offline',platform:3}],others_shared_devices:[]}}));
  await page.route('**/api/devices/*/apps',route=>route.fulfill({json:[]}));
  await page.reload();await page.waitForFunction(()=>document.querySelector('#device-status').classList.contains('online'));
  await page.getByRole('button',{name:'切换设备'}).click();
  await page.locator('[data-action="select-device"][data-id="offline-pc"]').click();
  assert.match(await page.locator('#device-status').textContent(),/离线/);
  await page.locator('#desktop-preview').click();assert.match(await page.locator('#toast').textContent(),/离线/);

  const loopback=await page.evaluate(async()=>{
    const {UuStreamer}=await import('/lib/streamer.js');
    const remote=new RTCPeerConnection({iceServers:[]});
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
    const ctx=canvas.getContext('2d');let frame=0;
    const timer=setInterval(()=>{ctx.fillStyle=frame++%2?'#125eb8':'#26a8c5';ctx.fillRect(0,0,640,360);ctx.fillStyle='#fff';ctx.fillRect((frame*4)%600,100,40,100);},33);
    const media=canvas.captureStream(30);for(const track of media.getTracks())remote.addTrack(track,media);
    let receivedInput;remote.ondatachannel=event=>{if(event.channel.label==='CONTROL_DATA_CHANNEL')event.channel.onmessage=e=>receivedInput=JSON.parse(new TextDecoder().decode(e.data));};
    class Signal {
      handlers=new Map();connected=false;ice=[];
      on(name,fn){const list=this.handlers.get(name)||[];list.push(fn);this.handlers.set(name,list);return this;}
      once(name,fn){return this.on(name,fn);}
      fire(name,data){for(const fn of this.handlers.get(name)||[])fn(data);}
      timeout(){return this;}
      connect(){this.connected=true;queueMicrotask(()=>this.fire('connect'));}
      disconnect(){this.connected=false;}
      removeAllListeners(){this.handlers.clear();}
      emit(event,...args){
        const cb=args.at(-1);
        if(event==='room_info')queueMicrotask(()=>cb(null,null,{publisher:{client_id:'loopback'},iceServers:[]}));
        if(event==='control')queueMicrotask(()=>cb(null,null,{client_id:'loopback',ice_id:'test-ice',iceServers:[]}));
        if(event==='soac')this.negotiate(args[0]).catch(e=>this.fire('connect_error',e));
        return this;
      }
      async negotiate({data}){
        if(data.type==='offer'){
          await remote.setRemoteDescription({type:'offer',sdp:data.sdp});
          for(const c of this.ice)await remote.addIceCandidate(c);this.ice=[];
          await remote.setLocalDescription(await remote.createAnswer());
          this.fire('soac',{data:{type:'answer',sdp:remote.localDescription.sdp,ice_id:'test-ice'}});
        }else if(data.type==='candidate'){
          const candidate=data.candidate;
          if(remote.remoteDescription)await remote.addIceCandidate(candidate);else this.ice.push(candidate);
        }
      }
    }
    const signal=new Signal();
    remote.onicecandidate=event=>{if(event.candidate)signal.fire('soac',{data:{type:'candidate',ice_id:'test-ice',candidate:event.candidate.toJSON()}});};
    const viewer=new UuStreamer({signalFactory:()=>signal,request:async()=>({})});
    const video=document.createElement('video');video.autoplay=true;video.muted=true;document.body.append(video);
    viewer.addEventListener('track',event=>{video.srcObject=event.detail.stream;video.play();});
    let error;viewer.addEventListener('error',event=>error=event.detail.message);
    try{
      await viewer.connect('loopback');
      const deadline=Date.now()+15000;
      while(Date.now()<deadline && (!video.videoWidth || video.currentTime<.3 || viewer.channels.get('CONTROL_DATA_CHANNEL')?.readyState!=='open')){
        if(error)throw new Error(error);await new Promise(r=>setTimeout(r,100));
      }
      if(!video.videoWidth || viewer.state!=='connected')throw new Error(`WebRTC loopback failed: ${viewer.state}, ${error}`);
      viewer.sendInput({action:'kbd_press',key:87});
      const inputDeadline=Date.now()+3000;
      while(!receivedInput && Date.now()<inputDeadline)await new Promise(r=>setTimeout(r,30));
      const report=await viewer.peer.getStats();let decoded=0;report.forEach(s=>{if(s.type==='inbound-rtp'&&s.kind==='video')decoded=s.framesDecoded;});
      return {width:video.videoWidth,height:video.videoHeight,decoded,input:receivedInput,state:viewer.state};
    }finally{await viewer.disconnect();remote.close();for(const track of media.getTracks())track.stop();clearInterval(timer);video.remove();}
  });
  assert.equal(loopback.state,'connected');assert.equal(loopback.width,640);assert.ok(loopback.decoded>0);assert.deepEqual(loopback.input,{action:'kbd_press',key:87});
  assert.deepEqual(errors,[]);
  console.log('PASS: desktop/mobile layout, assets, settings persistence, dialogs, login form, device switching, offline handling.');
  console.log('PASS: real browser WebRTC loopback:',JSON.stringify(loopback));
  console.log('Screenshots:',output);
}finally{await browser.close();}
