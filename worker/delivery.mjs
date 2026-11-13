import {sendPush as sendWebPush} from './push.mjs';
import {sendFcm} from './fcm.mjs';

// Providers are independent: a missing/failing Android configuration cannot suppress Web Push.
export async function sendPush(env,userIds,payload){
  return Promise.allSettled([sendWebPush(env,userIds,payload),sendFcm(env,userIds,payload)]);
}
