import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UuStreamer } from '../public/lib/streamer.js';
import { EventEmitter } from 'node:events';
import { fields } from '../public/lib/protobuf.js';

class Signal extends EventEmitter {
  connected=false;
  constructor(reply={}) { super(); this.reply=reply; this.events=[]; }
  connect() { this.connected=true; queueMicrotask(()=>super.emit('connect')); }
  timeout() { return this; }
  emit(event,...args) {
    if (['room_info','control'].includes(event)) {
      const cb=args.pop(); this.events.push([event,...args]);
      queueMicrotask(()=>cb(null,null,this.reply[event] ?? (event==='room_info'?{publisher:{client_id:'pc'},iceServers:[]}:{client_id:'pc',ice_id:'ice'})));
      return this;
    }
    this.events.push([event,...args]); return this;
  }
  disconnect(){this.connected=false;}
}
class Peer {
  connectionState='new';remoteDescription=null;localDescription=null;closed=false;ices=[];channels=[];
  addTransceiver(){return {setCodecPreferences(){}};}
  createDataChannel(label){const ch={label,readyState:'open',bufferedAmount:0,sent:[],send(b){this.sent.push(b)},close(){this.readyState='closed'}};this.channels.push(ch);return ch;}
  async createOffer(){return {type:'offer',sdp:'test-offer'}}
  async createAnswer(){return {type:'answer',sdp:'test-answer'}}
  async setLocalDescription(d){this.localDescription=d;}
  async setRemoteDescription(d){this.remoteDescription=d;}
  async addIceCandidate(c){this.ices.push(c);}
  close(){this.closed=true;}
}
test('controller negotiates native events, buffers ICE until answer, sends binary input and cleans up',async(t)=>{
  const socket=new Signal(),peer=new Peer(),requests=[];
  const c=new UuStreamer({signalFactory:()=>socket,peerFactory:()=>peer,request:async(...args)=>{requests.push(args);return {}}});
  t.after(()=>c.disconnect(false));
  await c.connect('device');
  assert.equal(c.state,'connecting');assert.deepEqual(socket.events.filter(x=>['room_info','control','soac'].includes(x[0])).map(x=>x[0]),['room_info','control','soac']);
  assert.equal(peer.channels.length,5);
  assert.equal(socket.events.find(e=>e[0]==='control')[1].streamer_data,'');
  const appData=socket.events.find(e=>e[0]==='control')[1].app_data;
  assert.equal(appData[0],4);
  // Native sio::packet::parse_buffer discards the first attachment byte.
  // Its remaining payload must still be a valid ConnectOptions message.
  const options=fields(appData.subarray(1));
  assert.equal(options.get(1)[0],1n);
  assert.equal(options.get(8)[0],2n);
  assert.equal(fields(options.get(3)[0]).get(1)[0],2n);
  await c.handleSoac({data:{type:'candidate',ice_id:'ice',candidate:{candidate:'candidate:one',sdpMid:'0',sdpMLineIndex:0}}});
  assert.equal(peer.ices.length,0);
  await c.handleSoac({data:{type:'answer',ice_id:'ice',sdp:'answer'}});assert.equal(peer.ices.length,1);
  assert.deepEqual(peer.ices[0],{candidate:'candidate:one',sdpMid:'0',sdpMLineIndex:0});
  await c.handleSoac({data:{type:'candidate',ice_id:'ice',candidate:{candidate:'candidate:two',sdpMid:'1',sdpMLineIndex:1}}});
  assert.deepEqual(peer.ices[1],{candidate:'candidate:two',sdpMid:'1',sdpMLineIndex:1});
  c.setState('connected'); assert.equal(c.sendInput({action:'kbd_press',key:87}),true);
  assert.equal(peer.channels[0].sent[0] instanceof Uint8Array,true);
  peer.channels[0].bufferedAmount=100000;assert.equal(c.sendInput({action:'mouse_move_absolute'}),false);
  assert.equal(c.sendInput({action:'kbd_release',key:87}),true);
  await c.disconnect();assert.equal(peer.closed,true);assert.equal(socket.connected,false);assert.equal(c.channels.size,0);assert.equal(c.state,'idle');
  assert.equal(requests.at(-1)[1].method,'DELETE');
});
test('a rejected control request fails visibly and releases signaling resources',async()=>{
  const socket=new Signal({control:{code:2002,msg:'device offline'}});
  const c=new UuStreamer({signalFactory:()=>socket,peerFactory:()=>new Peer(),request:async()=>({})});
  let message;c.addEventListener('error',event=>message=event.detail.message);
  await c.connect('pc');assert.equal(c.state,'error');assert.match(message,/offline/);assert.equal(socket.connected,false);
});
test('disconnect during pending room request does not create a late connection',async()=>{
  let finish;let calls=0;
  const c=new UuStreamer({signalFactory:()=>{calls++;return new Signal()},request:()=>new Promise(r=>finish=r)});
  const attempt=c.connect('pc');await new Promise(r=>setTimeout(r,0));await c.disconnect(false);finish({});await attempt;
  assert.equal(calls,0);assert.equal(c.state,'idle');
});
