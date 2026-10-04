# 实施接口契约
所有响应 JSON。错误 {error:{code,message,details?}}。集合直接数组，单个直接对象。注册/登录 {user,workspaces,csrf}，GET /api/me 同形。cookie HttpOnly session；写请求 X-CSRF-Token。workspace 路径 /api/w/:wid。extension 使用 Authorization: Bearer <device-token>，不走 Cookie。

## Root core ownership
export createStore(dataDir): Store; export registerCore(app,store).
Store 使用 records 表(kind,id,user_id,workspace_id,json)；put(kind,entity,userId?,workspaceId?), get(kind,id), list(kind,{userId?,workspaceId?}), remove(kind,id), transaction(fn), db。entity 必须 id。鉴权 export actor(req,store):{userId,device?}; workspace(req,store,write=false):{userId,workspaceId,role} 从 params.wid，write viewer 拒绝。fail(code,message,status=400,details?) throws。
材料 ingest export ingestRecord(store,wid,uid,record):{id,revision_id,status}; material = {id,workspace_id,source_key,group_id,author_id,author_name,title,text,entity_type,created_at,source_url,coverage,revision_id,status:'unread'|'read'|'adopted'|'ignored',tags:[],starred:false,revisions:[]}; revision {id,material_id,hash,text,fragments,coverage,captured_at}。

POST /api/auth/register {email,name,password}; login {email,password}; logout. GET /api/me. POST /api/auth/recovery/request {email}, POST /api/auth/recovery/complete {token,password} (out-of-band admin generated token, no simulated email).
GET/POST /api/workspaces (create {name}); GET /api/w/:wid/team, POST /invites {email,role}, POST /api/invites/accept {token}, PATCH /team/:userId {role}, DELETE /team/:userId.
GET /materials?q=&group_id=&author_id=&status=; GET /materials/:id; PATCH /materials/:id {status,tags,starred,reading_position}; DELETE /materials/:id (archive); POST /annotations {material_id,revision_id,start,end,quote,note}; GET /annotations?material_id=; PATCH/DELETE /annotations/:id.
GET/POST /datasets {name,mode:'manual'|'dynamic',material_ids:[],rule:{q?,group_id?,author_id?,tags?}}; GET/PATCH/DELETE /datasets/:id; POST /datasets/:id/freeze produces snapshot with [{material_id,revision_id}].
GET/POST /artifacts {title,body,citations:[],dataset_id?}; GET /artifacts/:id; PATCH /artifacts/:id {base_revision,title,body,citations,status}; POST /artifacts/:id/adopt {proposal_id?,base_revision}; GET revisions included; source changes stale=true. POST /share {target_workspace_id,material_ids:[],artifact_ids:[],include_raw:false,include_attachments:false} explicit only.
GET /export?material_ids=<comma>&artifact_ids=<comma>&annotations=true → TransferBundle; POST /import {bundle} X-Idempotency-Key; POST /uploads {hash,size,name,mime} -> {id,offset}; PUT /uploads/:id/chunks {offset,data_base64}; POST /uploads/:id/complete validates sha256. GET /attachments/:id authorized binary.
POST /devices/pair {label,workspace_id} returns {code,expires_at}; POST /api/devices/claim {code,label} returns {token,workspace_id}; GET /devices; DELETE /devices/:id.

## Runtime ownership
GET/POST /api/providers user-only {label,protocol:'chat'|'responses'|'anthropic',base_url,api_key,model,models:[],remember:true}; PATCH/DELETE /api/providers/:id; POST /:id/test {mode:'models'|'call'}; credentials encrypted, never returned.
POST /api/providers/discover {base_url,protocol,api_key?,provider_id?} 在保存前发现模型，不需要名称/model；返回 {models,verified:false,saved:false}。复用 provider_id 的旧Key仅限同一标准化地址；PATCH换地址也必须新Key，不向新目的地静默发旧凭据。call测试回传实际文本、模型、usage（以provider真实响应为准），不因模型发现成功标记推理verified。
GET/POST /api/connections {label,channel:'browser'|'official',api_key?,mcp_url?,policy:'browser_only'|'official_only'|'auto'}; DELETE /:id; POST /:id/open, /verify; GET /:id/screen returns {image data URL,width,height,url}; POST /:id/input {type:'click'|'text'|'key'|'scroll',x?,y?,text?,key?,delta?}; GET /:id/groups; GET /:id/groups/:gid/members?q=.
GET /api/recipes/presets => [{id,label,description,output_schema}]; GET/POST /api/w/:wid/recipes {name,preset_id,goal,provider_id,model,max_output_tokens,input_limit,max_calls,approval:'manual'|'automatic',material_ids:[],dataset_id?}; PATCH/DELETE /recipes/:id.
GET/POST /api/w/:wid/jobs; POST accepts {kind:'capture'|'process',connection_id?,scope:{group_id,author_id?,from?,to?,types?:['topic','answer','comment'],max_pages,include_comments,include_attachments},recipe_id?,material_ids?,approved:false}; process must confirm outbound plan via approve. GET /jobs/:id with events/checkpoint; POST /jobs/:id/:action action approve/pause/resume/cancel. Unknown billable results no auto retry; resume needs explicit retry_unknown flag.
GET jobs 集合返回 projection:'summary'（id/workspace/user/kind/state/timestamps/processed/artifact_ids），不含冻结inputs/原文、checkpoint、events、recipe、付费输出；完整事实另读 detail。任务执行器通过索引只取一个已批准queued任务。
POST /jobs/:id/retry_failed 仅采集的停止状态且存在已知失败项：同一核验账号、固定topic_id和阶段、不重扫首页、不增加max_pages。GET /jobs/:id/export?offset=0&limit=100（1–1000）分批TransferBundle，仅checkpoint.saved_records固定修订或实际成果引用；coverage返回total/next_offset/task_id/state。无固定回执的旧采集任务409；超16MiB413提示减小批量，不自动附原件/个人批注。设备需export scope。
POST /api/w/:wid/tools-tokens {label,scopes:['read','process','export']} finite MCP via /mcp, no generic network/shell. GET /tools-tokens; DELETE /tools-tokens/:id. MCP sessions bearer narrow scopes, tools list/get materials, create process job, job status, export (workspace pinned).

## TransferBundle v1
{schema_version:1,bundle_id,digest,exported_at,producer:{name,version},records:[],annotations:[],artifacts:[],attachments:[],coverage:{...}}.
record = {source_key:{platform:'zsxq',group_id,entity_type,entity_id},group_id,author_id,author_name,title,text,created_at,source_url,coverage:{body,comments,attachments,reasons:[]},fragments:[{id,text,start,end}],captured_at,hash?}. body/comments/attachments each complete/partial/inaccessible/failed. hash sha256(text). digest canonical JSON excluding digest, sha256 UTF-8. No credentials, signed URLs/local paths.
User/workspace never from package; import assigned by authenticated route. source revisions per workspace; identity source truth client_reported for imported packages. result {bundle_id,records:[{source_key,id,revision_id,status}],artifacts:[],attachments:[],...}. same idempotency/body receipt; different body 409.

Root supplies shared/transfer.ts: canonical,sha256,createBundle,validateBundle,fragmentsFor; shared/zsxq.ts: normalizeTopic(raw,groupId), sourcePaths, normalizeGroups.
