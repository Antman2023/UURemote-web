import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signRequest, UuApi } from '../server/uu-api.mjs';
import { ackValue, normalizeIceServers, remotePoint, virtualKey, soacMessage } from '../public/lib/protocol.js';
import { varint, connectOptions, fields, envelope, string } from '../public/lib/protobuf.js';
import { loadApkSigningKey } from '../server/apk.mjs';

test('signed API canonicalizes header names and order, and includes exact body bytes', () => {
  const headers = { 'X-Param-VC':'30500', 'X-Param-client-id':'device', 'Content-Type':'application/json', 'X-Param-TS':'42' };
  const canonical = 'POST/api/v1/testx-param-client-id=device&x-param-ts=42&x-param-vc=30500{"force_join":false}';
  assert.equal(signRequest('test', 'POST', '/api/v1/test', headers, '{"force_join":false}'), createHmac('sha256','test').update(canonical).digest('hex'));
  assert.equal(signRequest('test','GET','/test',headers), signRequest('test','GET','/test',Object.fromEntries(Object.entries(headers).reverse())));
});
test('the reference APK signing key can be read without exposing it', () => { assert.equal(loadApkSigningKey(process.cwd()).length,24); });
test('API rejects business errors and invalid JSON rather than returning invented data', async () => {
  const api = new UuApi('test', async () => new Response(JSON.stringify({code:2002,msg:'offline'}), {status:409}));
  await assert.rejects(api.request({clientId:'x'},'GET','/test'), /offline/);
  api.fetch = async () => new Response('<html>missing</html>', {status:404});
  await assert.rejects(api.request({clientId:'x'},'GET','/test'), /非 JSON/);
});
test('Socket.IO ACK rejects errors and supports native room_info and control responses', () => {
  assert.deepEqual(ackValue([{publisher:{client_id:'pc'}}],'room_info'), {publisher:{client_id:'pc'}});
  assert.deepEqual(ackValue([null,{ice_id:'ice'}],'control'), {ice_id:'ice'});
  assert.throws(()=>ackValue(['offline',null],'control'),/offline/);
  assert.throws(()=>ackValue([null,{code:2,msg:'occupied'}],'control'),/occupied/);
  assert.throws(()=>ackValue([{code:2,msg:'occupied'}],'room_info'),/occupied/);
});
test('SOAC retains native field names, ICE generation and app control identity', () => {
  assert.deepEqual(soacMessage('pc','offer',{sdp:'test'},'ice','app'), {client_id:'pc',data:{type:'offer',sdp:'test',ice_id:'ice',app_control_id:'app'}});
  assert.deepEqual(soacMessage('pc','candidate',{candidate:'candidate:test',sdpMid:'0',sdpMLineIndex:0},'ice','app'), {client_id:'pc',data:{type:'candidate',candidate:{candidate:'candidate:test',sdpMid:'0',sdpMLineIndex:0},ice_id:'ice',app_control_id:'app'}});
});
test('ICE server password is adapted to browser credential field', () => {
  assert.deepEqual(normalizeIceServers([{url:'turn:example.com',username:'u',password:'p'}]), [{urls:'turn:example.com',username:'u',credential:'p'}]);
  assert.throws(()=>normalizeIceServers([{}]),/无效/);
});
test('mouse coordinates respect letterboxing and use native normalized fractions', () => {
  const rect = {left:100,top:50,width:1000,height:1000};
  assert.equal(remotePoint({clientX:500,clientY:100},rect,1920,1080),null);
  assert.deepEqual(remotePoint({clientX:600,clientY:550},rect,1920,1080),{x:.5,y:.5});
  assert.deepEqual(remotePoint({clientX:100,clientY:268.75},rect,1920,1080),{x:0,y:0});
  assert.equal(remotePoint({clientX:1,clientY:1},{left:0,top:0,width:0,height:0},0,0),null);
});
test('browser physical keys map to Windows virtual key codes', () => {
  assert.equal(virtualKey('KeyW'),87); assert.equal(virtualKey('Digit1'),49); assert.equal(virtualKey('F12'),123);
  assert.equal(virtualKey('ArrowLeft'),37); assert.equal(virtualKey('Numpad4'),100); assert.equal(virtualKey('Unknown'),0);
});
test('ConnectOptions matches recovered protobuf field numbers including signed -1', () => {
  assert.equal(varint(-1).length,10);
  const opts=fields(connectOptions({width:2560,height:1440,fps:30,quality:4}));
  assert.equal(opts.get(1)[0],1n); assert.equal(BigInt.asIntN(64,opts.get(2)[0]),-1n); assert.equal(opts.get(8)[0],2n);
  const capture=fields(opts.get(3)[0]); assert.equal(capture.get(1)[0],1n); assert.equal(capture.get(2)[0],4n);
  const resolution=fields(capture.get(5)[0]); assert.equal(resolution.get(1)[0],2560n); assert.equal(resolution.get(2)[0],1440n);
  const decoder=fields(opts.get(4)[0]); assert.equal(decoder.get(2)[0],1n); assert.equal(decoder.get(1)[0],30n);
});
test('protobuf envelopes preserve sequence, timestamp and launch payload', () => {
  const m=fields(envelope(42,4,string(2,'Steam'),1234));
  assert.equal(m.get(1)[0],42n);assert.equal(m.get(2)[0],1234n);
  assert.equal(new TextDecoder().decode(fields(m.get(4)[0]).get(2)[0]),'Steam');
  assert.throws(()=>fields(new Uint8Array([10,10,1])),/Truncated/);
});
