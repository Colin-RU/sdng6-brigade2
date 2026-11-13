const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(__dirname + '/native-gps.js', 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
function phone() {
  const listeners = new Map(), calls = [];
  const context = {
    location:{origin:'https://appassets.androidplatform.net'}, navigator:{},
    setTimeout, clearTimeout, console,
    document:{readyState:'loading',addEventListener(name,callback){listeners.set(name,callback);}},
    SdngGps:{start(){calls.push('start');},stop(){calls.push('stop');},notificationsPageReady(){calls.push('page-ready');}}
  };
  context.window = context;
  context.addEventListener = (name, callback) => listeners.set(name, callback);
  vm.runInNewContext(source, context);
  return {api:context.navigator.geolocation, calls,
    ready(){listeners.get('DOMContentLoaded')();},
    fix(latitude=61.6) {listeners.get('sdng:gps')({detail:{latitude,longitude:73.7,accuracy:5,timestamp:Date.now()}});},
    error(code) {listeners.get('sdng:gps-error')({detail:{code,message:'GPS error'}});}};
}

test('native notification taps wait until deferred page listeners are ready',()=>{const p=phone();assert.deepEqual(p.calls,[]);p.ready();assert.deepEqual(p.calls,['page-ready']);});
test('independent current requests and watches keep the receiver active until the last subscriber leaves', async () => {
  const p = phone(), positions = [], errors = [];
  const first = p.api.watchPosition(v => positions.push(['first',v.coords.latitude]), e => errors.push(e));
  const second = p.api.watchPosition(v => positions.push(['second',v.coords.latitude]), e => errors.push(e));
  p.api.getCurrentPosition(v => positions.push(['current',v.coords.latitude]), e => errors.push(e));
  p.api.clearWatch(first);
  assert.equal(p.calls.at(-1), 'start');
  p.fix(); await pause();
  assert.deepEqual(positions.map(x=>x[0]).sort(), ['current','second']);
  assert.equal(p.calls.at(-1), 'start');
  p.api.clearWatch(second);
  assert.equal(p.calls.at(-1), 'stop');
  assert.equal(errors.length, 0);
});
test('a timed-out one-shot does not cancel a navigation watch', async () => {
  const p = phone(), errors = [], fixes = [];
  const watch = p.api.watchPosition(v => fixes.push(v));
  p.api.getCurrentPosition(()=>assert.fail('timed out'), e => errors.push(e), {timeout:1});
  await pause(); await pause();
  assert.equal(errors[0].code, 3);
  assert.equal(p.calls.at(-1), 'start');
  p.fix(); await pause();
  assert.equal(fixes.length,1);
  p.api.clearWatch(watch);
});
test('permission denial reaches every subscriber and stops location updates', async () => {
  const p = phone(), errors = [];
  p.api.watchPosition(()=>assert.fail('denied'), e=>errors.push(e));
  p.api.getCurrentPosition(()=>assert.fail('denied'), e=>errors.push(e));
  p.error(1); await pause();
  assert.equal(errors.length,2);
  assert.equal(errors.every(e=>e.code===1),true);
  assert.equal(p.calls.at(-1),'stop');
});
test('cached fixes respect maximumAge and do not activate another receiver', async () => {
  const p = phone(), fixes = [];
  p.api.getCurrentPosition(v=>fixes.push(v)); p.fix(); await pause();
  const before = p.calls.length;
  p.api.getCurrentPosition(v=>fixes.push(v), null, {maximumAge:15000});
  await pause();
  assert.equal(fixes.length,2);
  assert.equal(p.calls.length,before);
});
