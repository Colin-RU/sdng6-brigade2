// Server-side only. The service role key is supplied by the Edge runtime, never a browser.
export function postgresSql(sql) {
  const tables='profiles|sessions|rate_limits|media|chat_messages|object_notes|samples|sample_audit|object_statuses|status_audit|shifts|notifications|push_subscriptions|app_secrets';
  return sql.replace(/\bLIMIT -1\b/g,'LIMIT ALL').replace(/json_each\(\?\)/g,'jsonb_array_elements_text(?::jsonb) AS json_each(value)').replace(new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(${tables})\\b`,'gi'),(_,keyword,table)=>`${keyword} brigade."${table}"`);
}
export class SupabaseD1 {
  constructor(url,key,fetcher=fetch){Object.assign(this,{url:url.replace(/\/$/,''),key,fetcher});}
  prepare(sql){return new SupabaseStatement(this,postgresSql(sql));}
  async query(commands){
    const response=await this.fetcher(`${this.url}/rest/v1/rpc/brigade_query_batch`,{method:'POST',headers:{apikey:this.key,Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'},body:JSON.stringify({commands})});
    if(!response.ok){let code;try{code=(await response.json()).code;}catch{}throw new Error(code==='23505'?'UNIQUE constraint':'Database request failed');}
    const data=await response.json();if(!Array.isArray(data))throw new Error('Database response invalid');return data;
  }
  async batch(statements){return this.query(statements.map(s=>({sql:s.sql,params:s.args})));}
}
class SupabaseStatement {
  constructor(db,sql,args=[]){Object.assign(this,{db,sql,args});}
  bind(...args){return new SupabaseStatement(this.db,this.sql,args);}
  async run(){return (await this.db.query([{sql:this.sql,params:this.args}]))[0];}
  all(){return this.run();}
  async first(column){const row=(await this.run()).results?.[0]??null;return column&&row?row[column]:row;}
}
export class SupabaseBucket {
  constructor(url,key,bucket='brigade-media',fetcher=fetch){Object.assign(this,{url:url.replace(/\/$/,''),key,bucket,fetcher});}
  endpoint(key,authenticated=false){return `${this.url}/storage/v1/object/${authenticated?'authenticated/':''}${encodeURIComponent(this.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;}
  headers(extra={}){return {apikey:this.key,Authorization:`Bearer ${this.key}`,...extra};}
  async put(key,bytes,metadata={}){const response=await this.fetcher(this.endpoint(key),{method:'POST',headers:this.headers({'Content-Type':metadata.httpMetadata?.contentType??'application/octet-stream','x-upsert':'false','Cache-Control':'no-store'}),body:bytes});if(!response.ok)throw new Error('Storage upload failed');}
  async get(key){const response=await this.fetcher(this.endpoint(key,true),{headers:this.headers(),cache:'no-store'});if(response.status===404)return null;if(!response.ok)throw new Error('Storage read failed');return {body:response.body};}
  async delete(key){const response=await this.fetcher(`${this.url}/storage/v1/object/${encodeURIComponent(this.bucket)}`,{method:'DELETE',headers:this.headers({'Content-Type':'application/json'}),body:JSON.stringify({prefixes:[key]})});if(!response.ok)throw new Error('Storage delete failed');}
}
export function createSupabaseEnv({url,serviceRoleKey,publicKey=null,requestIp=null,fetcher=fetch}) {
  if(!url||!serviceRoleKey)throw new Error('Server bindings missing');
  return {DB:new SupabaseD1(url,serviceRoleKey,fetcher),BUCKET:new SupabaseBucket(url,serviceRoleKey,'brigade-media',fetcher),VAPID_PUBLIC_KEY:publicKey,REQUEST_IP:requestIp};
}
