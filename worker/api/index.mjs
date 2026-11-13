import {ApiError,fail,json,cors,originAllowed,rateLimit} from './core.mjs';
import {handleAuth,handleProfile,requireUser} from './auth.mjs';
import {handleMedia} from './media.mjs';
import {handleMessages} from './messages.mjs';
import {handleReactions} from './reactions.mjs';
import {handleField} from './field.mjs';
import {handleNotifications} from './notifications.mjs';
import {handleDevices} from './devices.mjs';
import {handleSamplingScheduler} from './sampling-scheduler.mjs';
export async function handleApi(request,env,ctx,hooks={}) {
  const pathname=new URL(request.url).pathname;
  if(pathname!=='/api/v1'&&!pathname.startsWith('/api/v1/'))return null;
  let response;
  try {
    if(!originAllowed(request))fail(403,'origin_denied','Источник запроса не разрешён.');
    if(request.method==='OPTIONS')return cors(request,new Response(null,{status:204}));
    const path=pathname.slice(7)||'/';
    if(path==='/health'&&request.method==='GET')return cors(request,json({ok:true}));
    if(!env.DB||!env.BUCKET)fail(503,'unavailable','Сервис временно недоступен.');
    response=await handleSamplingScheduler(request,env,path,ctx,hooks)??await handleAuth(request,env,path);
    if(!response){
      const user=await requireUser(request,env);
      if(!['GET','HEAD'].includes(request.method))await rateLimit(env,`writes:${user.id}`,120,60);
      response=await handleProfile(request,env,path,user)??await handleMedia(request,env,path,user)??await handleReactions(request,env,path,user)??await handleMessages(request,env,path,user,ctx,hooks)??await handleField(request,env,path,user)??await handleNotifications(request,env,path,user)??await handleDevices(request,env,path,user);
    }
    if(!response)fail(404,'not_found','Запрос не найден.');
  } catch(error) {
    if(error instanceof ApiError)response=json({error:{code:error.code,message:error.message,...(error.details?{details:error.details}:{})}},error.status,error.status===429?{'Retry-After':String(error.details?.retryAfter??60)}:{});
    else if(error instanceof URIError)response=json({error:{code:'invalid_path',message:'Некорректный адрес запроса.'}},400);
    else { console.error('API request failed',error?.name??'Error');response=json({error:{code:'internal_error',message:'Не удалось выполнить запрос. Попробуйте позже.'}},500); }
  }
  return cors(request,response);
}
