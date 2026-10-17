import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smsCredentials, sendSmsCode, loginBySms } from '../server/sms-auth.mjs';
import { UuApi } from '../server/uu-api.mjs';

const phone = { countryCode: '+86', mobile: '13800000000' };
const login = { ...phone, code: '012345' };
function fakeApi(request = async () => ({})) {
  const calls = [];
  return { calls, initialize: async () => {}, async request(...args) { calls.push(args); return request(...args); } };
}

test('SMS validates country, mobile and code without converting away leading zeroes', () => {
  assert.deepEqual(smsCredentials({ countryCode: ' +86 ', mobile: '138 0000-0000', code: '012345' }, true), { country_code: '86', mobile: '13800000000', code: '012345' });
  assert.deepEqual(smsCredentials({ countryCode: '+852', mobile: '51234567' }), { country_code: '852', mobile: '51234567' });
  for (const bad of [{mobile:'123'}, {...phone,countryCode:'abc'}, {...phone,countryCode:86}, {...phone,mobile:'138x0000000'}]) assert.throws(() => smsCredentials(bad), {status:400});
  for (const code of ['12345', '1234567', 'abc123', 123456]) assert.throws(() => smsCredentials({...phone,code},true), {status:400});
});

test('SMS code request matches APK fields and enforces 60-second cooldown', async () => {
  const api = fakeApi(), session = {};
  const result = await sendSmsCode(api, session, phone, () => 100000);
  assert.deepEqual(result, {retryAfter:60});
  assert.deepEqual(api.calls[0].slice(1), ['POST','/api/v1/security/mobile/code',{country_code:'86',mobile:'13800000000',type:'login'}]);
  await assert.rejects(sendSmsCode(api, session, phone, () => 110000), {status:429,retryAfter:50});
  assert.equal(api.calls.length, 1);
  await sendSmsCode(api, session, phone, () => 160000);
  assert.equal(api.calls.length, 2);
});

test('concurrent sends are rejected and failed sends can be retried', async () => {
  let finish;
  const api = fakeApi(() => new Promise(resolve => { finish = resolve; })), session = {};
  const pending = sendSmsCode(api, session, phone);
  await assert.rejects(sendSmsCode(api, session, phone), {status:429});
  await new Promise(resolve => setImmediate(resolve)); finish({}); await pending;
  const failedSession = {}, failedApi = fakeApi(async () => { throw new Error('official rejection'); });
  await assert.rejects(sendSmsCode(failedApi, failedSession, phone), /official rejection/);
  assert.equal(failedSession.smsSending, false); assert.equal(failedSession.smsRetryAt, undefined);
});

test('SMS login replaces the account only on success and keeps the token server-side', async () => {
  let aborted=false,closed=0;
  const session={token:'old-token',qr:{controller:{abort(){aborted=true;}}}};
  const api=fakeApi(async()=>({token:'private-new-token',user_id:'user',nickname:'测试账号'}));
  const result=await loginBySms(api,session,login,()=>closed++);
  assert.deepEqual(api.calls[0].slice(1),['POST','/api/v1/login/by_mobile',{country_code:'86',mobile:'13800000000',code:'012345'}]);
  assert.equal(aborted,true);assert.equal(closed,1);assert.equal(session.token,'private-new-token');
  assert.deepEqual(result,{user:{user_id:'user',nickname:'测试账号'}});
  assert.equal(JSON.stringify(result).includes('token'),false);
  assert.equal(session.smsAttempt,undefined);
});

test('wrong SMS codes and incomplete responses preserve the existing account and connection', async () => {
  const session={token:'old-token',userId:'old-user'};
  let closed=false;
  await assert.rejects(loginBySms(fakeApi(async()=>{throw new Error('验证码错误');}),session,login,()=>closed=true),/验证码错误/);
  await assert.rejects(loginBySms(fakeApi(async()=>({token:'bad'})),session,login,()=>closed=true),/缺少账号信息/);
  assert.equal(session.token,'old-token');assert.equal(session.userId,'old-user');assert.equal(closed,false);
});

test('late SMS login cannot restore a logged-out or superseded account', async () => {
  let finish;
  const api=fakeApi(()=>new Promise(resolve=>finish=resolve)),session={};
  const pending=loginBySms(api,session,login,()=>assert.fail('must not replace a cancelled session'));
  await new Promise(resolve=>setImmediate(resolve));
  session.smsAttempt=undefined;
  finish({token:'late-token',user_id:'late-user'});
  await assert.rejects(pending,{status:409});assert.equal(session.token,undefined);
});

test('UU API accepts successful SMS responses with no content', async () => {
  for (const status of [204,205]) {
    const api=new UuApi('test',async()=>new Response(null,{status}));
    assert.equal(await api.request({clientId:'test'},'POST','/api/v1/security/mobile/code',{}),undefined);
  }
});
