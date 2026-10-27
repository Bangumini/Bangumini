import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const root = new URL("../", import.meta.url);
const disk = new Map();
const io = { failReads:false, failReadKey:null, failWrites:false, failAt:0, writeGate:null, writes:0, active:0, max:0 };
const storageListeners = new Set();
const storage = {
 getItem(key) { if(io.failReads || io.failReadKey===key) throw Error('read failed'); return disk.get(key)??null; },
 setItem(key,value) { io.writes++; io.active++; io.max=Math.max(io.max,io.active); try { if(io.failWrites || io.writes===io.failAt) throw Error('write failed'); disk.set(key,String(value)); } finally { io.active--; } },
};
globalThis.window = { localStorage:storage, addEventListener(type,listener) { if(type==='storage')storageListeners.add(listener); } };
const store=await import(new URL('src/api/airing-offset.ts',root));
const {createAiringOffsetSyncManager}=await import(new URL('src/api/airing-offset-sync-manager.ts',root));
const record=(days,revision)=>({days,revision,updatedAt:1});
const document=(account,records)=>JSON.stringify({schemaVersion:1,kind:'bangumini-airing-offsets',account,records});
const config={provider:'webdav',autoSync:false,prefix:'bangumini',url:'https://dav.example.test',username:'private-user',password:'fake-secret'};
const configurations=new Map();
const remote={content:document('alice',{'20':record(2,'remote-20')}),version:1,writes:0};
const managerDeps={
 setAccount:store.setAiringOffsetAccount,readLocal:store.readAiringOffsetAccountState,updateLocal:store.updateAiringOffsetAccountState,subscribeLocal:store.subscribeAiringOffsetState,
 configs:{get:async account=>configurations.get(account)??null,set:async(account,value)=>{configurations.set(account,value);},delete:async account=>{configurations.delete(account);}},
 createStorage:()=>({read:async()=>remote.content===null?null:{content:remote.content,etag:`"${remote.version}"`},write:async(content,expected)=>{if(expected!==(remote.content===null?null:`"${remote.version}"`))throw Object.assign(new Error('precondition'),{name:'OffsetSyncPreconditionError'});remote.content=content;remote.version++;remote.writes++;}}),
 isPreconditionError:error=>error?.name==='OffsetSyncPreconditionError',formatStorageError:()=> '远端请求失败',newRevision:randomUUID,
};
const manager=createAiringOffsetSyncManager(managerDeps);
await manager.setAccount('alice');
await store.setAiringOffsetDays(10,-1);
await manager.saveConfig(config);
assert.equal(manager.getSnapshot().enabled,false,'保存配置不隐式开启同步');
await manager.setEnabled(true);
await manager.syncNow();
assert.deepEqual(store.getAiringOffsetsSnapshot(),{'10':-1,'20':2},'一次合并本机与远端的不同条目');
assert.equal(JSON.parse(remote.content).records['10'].days,-1,'本机新偏置已提交远端');
assert.equal(manager.getSnapshot().phase,'idle');
assert.deepEqual(manager.getSnapshot().conflicts,[]);
const stableMap=store.getAiringOffsetsSnapshot(),writes=remote.writes;
await manager.syncNow();
assert.strictEqual(store.getAiringOffsetsSnapshot(),stableMap,'同内容同步不改变已展示的偏置引用');
assert.equal(remote.writes,writes,'没有变化时不重复上传');
await store.setAiringOffsetDays(10,-2);
const changed=JSON.parse(remote.content);changed.records['10']=record(3,'remote-concurrent');remote.content=JSON.stringify(changed);remote.version++;
await manager.syncNow();
assert.equal(manager.getSnapshot().phase,'conflict');
assert.equal(store.getAiringOffsetsSnapshot()[10],-2,'未选择时保留本机偏置');
assert.equal(JSON.parse(remote.content).records['10'].days,3,'未选择时不得覆盖远端');
await manager.syncNow();
assert.equal(manager.getSnapshot().conflicts.length,1,'重复同步不能把冲突基线提前推进');
await manager.resolveConflict(10,'local');
assert.equal(JSON.parse(remote.content).records['10'].days,-2,'选择本机后才覆盖所见远端版本');
assert.equal(manager.getSnapshot().conflicts.length,0);
await store.setAiringOffsetDays(10,-3);
const again=JSON.parse(remote.content);again.records['10']=record(4,'remote-next');remote.content=JSON.stringify(again);remote.version++;
await manager.syncNow();
await manager.resolveConflict(10,'remote');
assert.equal(store.getAiringOffsetsSnapshot()[10],4,'选择远端后一次更新本机');
await manager.setAccount('bob');
assert.deepEqual(store.getAiringOffsetsSnapshot(),{},'切账号不能携带上一账号的偏置');
assert.equal(manager.getSnapshot().configured,false,'切账号不能携带上一账号的凭证');
await manager.setAccount('alice');
assert.equal(store.getAiringOffsetsSnapshot()[10],4);
assert.equal(manager.getSnapshot().configured,true);
assert(!JSON.stringify(manager.getSnapshot()).includes('fake-secret'),'公开状态不能携带凭证');
await store.setAiringOffsetDays(10,5);
const choosing=JSON.parse(remote.content);choosing.records['10']=record(6,'remote-shown');remote.content=JSON.stringify(choosing);remote.version++;
await manager.syncNow();
const newer=JSON.parse(remote.content);newer.records['10']=record(7,'remote-unseen');remote.content=JSON.stringify(newer);remote.version++;
await manager.resolveConflict(10,'remote');
assert.equal(store.getAiringOffsetsSnapshot()[10],6,'选择所见远端6不能被未展示的新远端7静默覆盖');
assert.equal(manager.getSnapshot().phase,'conflict');
assert.equal(manager.getSnapshot().conflicts[0].remote.days,7,'新的远端版本必须再次提示');
await manager.resolveConflict(10,'remote');
assert.equal(store.getAiringOffsetsSnapshot()[10],7);
await manager.disconnect();
assert.equal(manager.getSnapshot().configured,false);
assert.equal(manager.getSnapshot().enabled,true,'断开只删除配置，不关闭本地开关');
assert.equal(store.getAiringOffsetsSnapshot()[10],7,'断开不删本机偏置');
assert.equal(JSON.parse(remote.content).records['10'].days,7,'断开不删远端文件');
manager.dispose();
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const aliceCredentials=deferred(),aliceReading=deferred();
const isolated=createAiringOffsetSyncManager({...managerDeps,
 configs:{...managerDeps.configs,get:async account=>{if(account==='alice'){aliceReading.resolve();return aliceCredentials.promise;}return {...config,username:'bob-user'};}},
 createStorage:(credentials,account)=>({read:async()=>{assert.equal(credentials.username,`${account}-user`,'迟到的Alice配置不能覆盖Bob当前使用的凭证');return null;},write:async()=>{}}),
});
const oldAlice=isolated.setAccount('alice');await aliceReading.promise;
await isolated.setAccount('bob');aliceCredentials.resolve({...config,username:'alice-user'});await oldAlice;
await isolated.setEnabled(true);
await isolated.syncNow();
isolated.dispose();
const loadingConfig=deferred(),configStarted=deferred();
const backgrounded=createAiringOffsetSyncManager({...managerDeps,configs:{...managerDeps.configs,get:async()=>{configStarted.resolve();return loadingConfig.promise;}}});
backgrounded.setAppActive(true);
const activating=backgrounded.setAccount('alice');await configStarted.promise;
backgrounded.setAppActive(false);loadingConfig.resolve(config);await activating;
backgrounded.setAppActive(true);
assert.equal(backgrounded.getSnapshot().ready,true,'读取配置期间进后台不能永久卡住账号初始化');
await backgrounded.syncNow();
backgrounded.dispose();
const uploadStarted=deferred(),releaseUpload=deferred();let holdUpload=true;
configurations.set('alice',config);
const racing=createAiringOffsetSyncManager({...managerDeps,createStorage:()=>({
 read:managerDeps.createStorage().read,
 write:async(content,etag)=>{if(holdUpload){uploadStarted.resolve();await releaseUpload.promise;holdUpload=false;}return managerDeps.createStorage().write(content,etag);}
})});
await racing.setAccount('alice');await store.setAiringOffsetDays(10,8);
const uploading=racing.syncNow();assert.strictEqual(racing.syncNow(),uploading,'同一轮必须共享完整Promise');await uploadStarted.promise;
await store.setAiringOffsetDays(10,9);releaseUpload.resolve();await uploading;
assert.equal(store.getAiringOffsetsSnapshot()[10],9,'上传8期间保存的9不能被确认8回滚');
assert.equal(JSON.parse(remote.content).records['10'].days,8);
await racing.syncNow();assert.equal(JSON.parse(remote.content).records['10'].days,9,'下一轮应补传持久化的新意图');
racing.dispose();
let forcePrecondition=true;
const cas=createAiringOffsetSyncManager({...managerDeps,createStorage:()=>({read:managerDeps.createStorage().read,write:async(content,etag)=>{
 if(forcePrecondition){forcePrecondition=false;const concurrent=JSON.parse(remote.content);concurrent.records['30']=record(3,'another-device-30');remote.content=JSON.stringify(concurrent);remote.version++;}
 return managerDeps.createStorage().write(content,etag);
}})});
await cas.setAccount('alice');await store.setAiringOffsetDays(10,10);await cas.syncNow();
assert.equal(store.getAiringOffsetsSnapshot()[30],3,'CAS失败重读后不能丢另一设备新增的条目');
assert.equal(JSON.parse(remote.content).records['10'].days,10);cas.dispose();
let unavailable=false;
const offlineChoice=createAiringOffsetSyncManager({...managerDeps,createStorage:()=>({read:async()=>{if(unavailable)throw Error('fake-secret network failure');return managerDeps.createStorage().read();},write:managerDeps.createStorage().write})});
await offlineChoice.setAccount('alice');await store.setAiringOffsetDays(10,11);
const remoteTwelve=JSON.parse(remote.content);remoteTwelve.records['10']=record(12,'remote-twelve');remote.content=JSON.stringify(remoteTwelve);remote.version++;
await offlineChoice.syncNow();unavailable=true;
await assert.rejects(offlineChoice.resolveConflict(10,'remote'),/已保存在本机/);
assert.equal(store.getAiringOffsetsSnapshot()[10],12,'用户明确选择的值离线也保存在本机');
assert(!offlineChoice.getSnapshot().error.includes('fake-secret'));
unavailable=false;await offlineChoice.syncNow();assert.equal(offlineChoice.getSnapshot().conflicts.length,0);offlineChoice.dispose();
const waitFor=async predicate=>{const deadline=Date.now()+1500;while(!predicate()){assert(Date.now()<deadline,'等待自动同步超时');await new Promise(resolve=>setTimeout(resolve,5));}};
let autoReads=0;
const automatic=createAiringOffsetSyncManager({...managerDeps,debounceMs:5,retryDelays:[5],timeoutMs:100,
 configs:{...managerDeps.configs,get:async()=>({...config,autoSync:true})},
 createStorage:()=>({read:async()=>{autoReads++;if(autoReads===1)throw Error('offline');return managerDeps.createStorage().read();},write:managerDeps.createStorage().write}),
});
automatic.setAppActive(true);await automatic.setAccount('alice');
await waitFor(()=>autoReads>=2&&automatic.getSnapshot().phase==='idle');
await new Promise(resolve=>setTimeout(resolve,15));assert.equal(autoReads,2,'同步元数据写入不能触发无限自动刷新');
await store.setAiringOffsetDays(40,-4);
await waitFor(()=>JSON.parse(remote.content).records['40']?.days===-4&&automatic.getSnapshot().phase==='idle');
automatic.setAppActive(false);const stoppedAt=autoReads;await store.setAiringOffsetDays(40,3);
await new Promise(resolve=>setTimeout(resolve,20));assert.equal(autoReads,stoppedAt,'后台本地保存不应启动网络');
automatic.setAppActive(true);
await waitFor(()=>JSON.parse(remote.content).records['40']?.days===3&&automatic.getSnapshot().phase==='idle');
automatic.dispose();
const oldGet=deferred(),oldGetStarted=deferred();
const leaving=createAiringOffsetSyncManager({...managerDeps,createStorage:()=>({read:async()=>{oldGetStarted.resolve();return oldGet.promise;},write:async()=>{throw Error('old account must not write');}})});
await leaving.setAccount('alice');const oldRound=leaving.syncNow();await oldGetStarted.promise;
await leaving.setAccount('bob');oldGet.resolve({content:document('alice',{'999':record(99,'late-old')}),etag:'"old"'});await oldRound;
assert.equal(leaving.getSnapshot().account,'bob');assert.deepEqual(store.getAiringOffsetsSnapshot(),{},'迟到的旧账号网络不能发布到当前页面');
assert.equal((await store.readAiringOffsetAccountState('alice')).records['999'],undefined,'迟到轮次也不能回写旧账号本地缓存');
leaving.dispose();
// 以下仍使用真实公开 store/manager；只在外部持久化与网络边界注入延迟和失败。
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let storeVersion=0;
const loadStore=()=>import(new URL('src/api/airing-offset.ts',root).href+`?enabled=${storeVersion++}`);
const localDeps=local=>({...managerDeps,setAccount:local.setAiringOffsetAccount,readLocal:local.readAiringOffsetAccountState,updateLocal:async(account,update)=>{if(io.writeGate)await io.writeGate;return local.updateAiringOffsetAccountState(account,update);},subscribeLocal:local.subscribeAiringOffsetState});
const reset=()=>{disk.clear();configurations.clear();io.failWrites=false;io.failAt=0;io.writeGate=null;};
reset();
const emptyStore=await loadStore();let emptyNetwork=0;
const emptyDeps={...localDeps(emptyStore),debounceMs:1,createStorage:()=>{emptyNetwork++;throw Error('没有配置不得创建网络客户端');}};
const empty=createAiringOffsetSyncManager(emptyDeps);
assert.equal(empty.getSnapshot().enabled,false,'初始公开状态默认关闭');
empty.setAppActive(true);await empty.setAccount('alice');
assert.equal(empty.getSnapshot().enabled,false,'新账号默认关闭');
await assert.rejects(empty.syncNow(),/开启/);
await assert.rejects(empty.testConnection(config),/开启/);
await assert.rejects(empty.resolveConflict(1,'local'),/开启/);
await empty.setEnabled(true);
assert.equal(empty.getSnapshot().enabled,true,'没有配置也可开启，供 UI 展开配置入口');
assert.equal(empty.getSnapshot().configured,false);
await sleep(10);assert.equal(emptyNetwork,0);
empty.dispose();
const emptyRestartStore=await loadStore();
const emptyRestart=createAiringOffsetSyncManager({...emptyDeps,...localDeps(emptyRestartStore)});
await emptyRestart.setAccount('alice');assert.equal(emptyRestart.getSnapshot().enabled,true,'重启按账号恢复开启状态');
await emptyRestart.setAccount('bob');assert.equal(emptyRestart.getSnapshot().enabled,false,'新账号不继承另一账号开关');
emptyRestart.setAppActive(true);await emptyRestart.saveConfig({...config,autoSync:true});
assert.equal(emptyRestart.getSnapshot().enabled,false,'关闭状态保存 autoSync 配置不启用');
assert.equal((await emptyRestart.getConfig()).autoSync,true,'关闭时仍可管理安全配置');
await sleep(10);assert.equal(emptyNetwork,0);
await emptyRestart.disconnect();assert.equal(emptyRestart.getSnapshot().enabled,false);
assert.equal(await emptyRestart.getConfig(),null);
await emptyRestart.setAccount('alice');assert.equal(emptyRestart.getSnapshot().enabled,true);
await emptyRestart.disconnect();assert.equal(emptyRestart.getSnapshot().enabled,true,'无配置的开启状态断开后仍开启');
emptyRestart.dispose();

// 已有 autoSync 配置和旧数据库均不能绕过默认关闭；关闭立即取消 GET、探测及其迟到候选。
reset();
const {offsetSyncTargetKey}=await import(new URL('shared/offset-sync-config.ts',root));
const autoConfig={...config,autoSync:true},target=offsetSyncTargetKey(autoConfig,'alice');
const initialRecords={'51':record(1,'existing-base')};
const oldPreferenceState={records:initialRecords,bases:{[target]:initialRecords},syncedAt:{[target]:42}};
disk.set(store.AIRING_OFFSET_ACCOUNTS_STORAGE_KEY,JSON.stringify({version:1,legacyOwner:'alice',accounts:{'account:alice':oldPreferenceState}}));
configurations.set('alice',autoConfig);
const gatedStore=await loadStore(),lateGet=deferred();
let gatedReads=0,gatedWrites=0,holdReads=true;
const signals=[];
let normalRemote=document('alice',initialRecords);
const gated=createAiringOffsetSyncManager({...localDeps(gatedStore),debounceMs:1,retryDelays:[5],createStorage:()=>({
 read:async signal=>{gatedReads++;signals.push(signal);if(holdReads)return lateGet.promise;return {content:normalRemote,etag:'"current"'};},
 write:async content=>{gatedWrites++;normalRemote=content;},
})});
gated.setAppActive(true);await gated.setAccount('alice');
assert.equal(gated.getSnapshot().enabled,false,'旧账号没有开关字段时也默认关闭');
assert.equal(gated.getSnapshot().configured,true);assert.equal(gated.getSnapshot().autoSync,true);
await gatedStore.setAiringOffsetDays(50,2);
gated.setAppActive(false);gated.setAppActive(true);
await sleep(15);assert.equal(gatedReads,0,'旧 autoSync 配置、前台恢复和偏置保存均不能自动联网');
await assert.rejects(gated.syncNow(),/开启/);await assert.rejects(gated.testConnection(autoConfig),/开启/);
await gated.setEnabled(true);await waitFor(()=>gatedReads===1);
const pendingRound=gated.syncNow();
const pendingProbe=assert.rejects(gated.testConnection(autoConfig),/取消|变化/);
await waitFor(()=>gatedReads===2);
const beforeClose=await gatedStore.readAiringOffsetAccountState('alice');
const beforeCloseMap=gatedStore.getAiringOffsetsSnapshot();let closeFlatEvents=0;
const stopCloseFlat=gatedStore.subscribeAiringOffsets(()=>closeFlatEvents++);
const closing=gated.setEnabled(false);
assert(signals.every(signal=>signal.aborted),'关闭调用立即中止同步 GET 和只读连接测试');
await assert.rejects(gated.syncNow(),/开启/);
await closing;await pendingRound;await pendingProbe;
assert.equal(gated.getSnapshot().enabled,false);
assert.equal(gated.getSnapshot().lastSyncedAt,42);
assert.deepEqual(await gatedStore.readAiringOffsetAccountState('alice'),{...beforeClose,syncEnabled:false},'关闭不丢记录、基线或同步时间');
const closeDisk=disk.get(store.AIRING_OFFSET_ACCOUNTS_STORAGE_KEY),closeWrites=io.writes,closedStatus=gated.getSnapshot();
lateGet.resolve({content:document('alice',{'999':record(99,'late-after-disable')}),etag:'"late"'});
await sleep(15);
assert.equal(io.writes,closeWrites,'迟到 GET 和探测不能落盘');
assert.strictEqual(gated.getSnapshot(),closedStatus,'迟到结果不能发布状态');
assert.equal(disk.get(store.AIRING_OFFSET_ACCOUNTS_STORAGE_KEY),closeDisk);
assert.equal(gatedWrites,0,'迟到 GET 不得提交远端候选');
assert.strictEqual(gatedStore.getAiringOffsetsSnapshot(),beforeCloseMap);
assert.equal(closeFlatEvents,0,'纯开关和迟到候选不重发 offsetMap');
stopCloseFlat();
gated.setAppActive(false);gated.setAppActive(true);
await gatedStore.setAiringOffsetDays(52,3);await gated.saveConfig(autoConfig);
await assert.rejects(gated.syncNow(),/开启/);await assert.rejects(gated.testConnection(autoConfig),/开启/);
await assert.rejects(gated.resolveConflict(51,'remote'),/开启/);
await sleep(15);assert.equal(gatedReads,2,'关闭后重试、前台、保存及手动入口均不得联网');
assert.equal((await gated.getConfig()).password,config.password,'关闭保留凭证');
assert.deepEqual((await gatedStore.readAiringOffsetAccountState('alice')).bases,beforeClose.bases);
holdReads=false;await gated.setEnabled(true);
await waitFor(()=>gatedReads>2&&gated.getSnapshot().phase==='idle');
assert.equal(JSON.parse(normalRemote).records['52'].days,3,'重新开启恢复原配置并自动上传关闭期间的新偏置');
assert.equal((await gatedStore.readAiringOffsetAccountState('alice')).bases[target]['51'].revision,'existing-base','重开复用已有基线');
assert(!JSON.stringify(gated.getSnapshot()).includes('fake-secret'));
gated.dispose();

// autoSync=false 仅放行手动同步；开关持久化失败保持确认值、数据与凭证。
reset();configurations.set('alice',config);
const failureStore=await loadStore();let failureReads=0;
const failure=createAiringOffsetSyncManager({...localDeps(failureStore),debounceMs:1,createStorage:()=>({read:async()=>{failureReads++;return null;},write:async()=>{}})});
failure.setAppActive(true);await failure.setAccount('alice');await failureStore.setAiringOffsetDays(1,1);
const failureMap=failureStore.getAiringOffsetsSnapshot();let failureFlatEvents=0;
const stopFailureFlat=failureStore.subscribeAiringOffsets(()=>failureFlatEvents++);
io.failWrites=true;
await assert.rejects(failure.setEnabled(true),/开关保存失败/);
assert.equal(failure.getSnapshot().enabled,false);assert.equal(failure.getSnapshot().phase,'error');
assert.match(failure.getSnapshot().error,/开关保存失败/);
assert.equal((await failureStore.readAiringOffsetAccountState('alice')).syncEnabled,false);
assert(!JSON.stringify(failure.getSnapshot()).includes('fake-secret'),'持久化异常不泄露凭证');
io.failWrites=false;await failure.setEnabled(true);await sleep(10);
assert.equal(failureReads,0,'autoSync=false 开启后不自动同步');
await failure.syncNow();assert.equal(failureReads,1,'开启后允许手动同步');
const beforeFailedClose=await failureStore.readAiringOffsetAccountState('alice');
io.failWrites=true;await assert.rejects(failure.setEnabled(false),/开关保存失败/);
assert.equal(failure.getSnapshot().enabled,true,'关闭失败恢复原开关');
assert.deepEqual(await failureStore.readAiringOffsetAccountState('alice'),beforeFailedClose);
assert.strictEqual(failureStore.getAiringOffsetsSnapshot(),failureMap);assert.equal(failureFlatEvents,0);
assert.equal((await failure.getConfig()).password,config.password);
io.failWrites=false;await failure.syncNow();assert.equal(failureReads,2,'失败回滚后仍可手动同步');
stopFailureFlat();

// 延迟写入和账号切换不能把旧调用偏好写给新账号或发布旧状态。
await failure.setEnabled(false);
const accountWriteGate=deferred();io.writeGate=accountWriteGate.promise;
const enablingAlice=failure.setEnabled(true);
const switchingBob=failure.setAccount('bob');
assert.equal(failure.getSnapshot().account,'bob');assert.equal(failure.getSnapshot().enabled,false);
accountWriteGate.resolve();io.writeGate=null;
await Promise.all([enablingAlice,switchingBob]);
assert.equal(failure.getSnapshot().account,'bob');assert.equal(failure.getSnapshot().enabled,false);
assert.equal((await failureStore.readAiringOffsetAccountState('alice')).syncEnabled,true);
assert.equal((await failureStore.readAiringOffsetAccountState('bob')).syncEnabled,false);
await failure.setAccount('alice');assert.equal(failure.getSnapshot().enabled,true);
const rapidGate=deferred();io.writeGate=rapidGate.promise;
const rapid=[failure.setEnabled(false),failure.setEnabled(true),failure.setEnabled(false)];
rapidGate.resolve();io.writeGate=null;await Promise.all(rapid);
assert.equal(failure.getSnapshot().enabled,false);
assert.equal((await failureStore.readAiringOffsetAccountState('alice')).syncEnabled,false,'快速切换以最后一次持久化意图为准');
assert.equal(failureReads,2,'切账号和快速开关不得偷偷联网');
io.failAt=io.writes+2;
const unconfirmedEnable=failure.setEnabled(true);
const failedFollowingDisable=assert.rejects(failure.setEnabled(false),/开关保存失败/);
await Promise.all([unconfirmedEnable,failedFollowingDisable]);
assert.equal(failure.getSnapshot().enabled,true,'前一次已落盘而未发布，后一次失败时必须恢复真实确认值');
assert.equal((await failureStore.readAiringOffsetAccountState('alice')).syncEnabled,true);
io.failAt=0;await failure.setEnabled(false);
failure.dispose();
const preferenceRestartStore=await loadStore();
const preferenceRestart=createAiringOffsetSyncManager(localDeps(preferenceRestartStore));
await preferenceRestart.setAccount('alice');assert.equal(preferenceRestart.getSnapshot().enabled,false);
assert.equal(preferenceRestart.getSnapshot().configured,true,'重启保留关闭账号的配置');
assert.deepEqual((await preferenceRestartStore.readAiringOffsetAccountState('alice')).bases,beforeFailedClose.bases,'重启保留基线');
await preferenceRestart.setAccount('bob');assert.equal(preferenceRestart.getSnapshot().enabled,false);
preferenceRestart.dispose();

// 开启恢复凭证期间再关闭/切账号，迟到恢复不能重新调度网络。
reset();configurations.set('alice',autoConfig);
const restoringStore=await loadStore();let configGate=null,restoreReads=0;
const restoring=createAiringOffsetSyncManager({...localDeps(restoringStore),debounceMs:1,
 configs:{...managerDeps.configs,get:async account=>{if(account==='alice'&&configGate){configGate.started.resolve();return configGate.result.promise;}return configurations.get(account)??null;}},
 createStorage:()=>({read:async()=>{restoreReads++;return null;},write:async()=>{}}),
});
restoring.setAppActive(true);await restoring.setAccount('alice');
configGate={started:deferred(),result:deferred()};
const delayedEnable=restoring.setEnabled(true);await configGate.started.promise;
await restoring.setEnabled(false);configGate.result.resolve(autoConfig);await delayedEnable;
await sleep(10);assert.equal(restoring.getSnapshot().enabled,false);assert.equal(restoreReads,0);
configGate={started:deferred(),result:deferred()};
const oldEnable=restoring.setEnabled(true);await configGate.started.promise;
await restoring.setAccount('bob');configGate.result.resolve(autoConfig);await oldEnable;
await sleep(10);assert.equal(restoring.getSnapshot().account,'bob');assert.equal(restoring.getSnapshot().enabled,false);
assert.equal(restoreReads,0,'迟到启用不得给新账号带入 autoSync');
assert.equal((await restoringStore.readAiringOffsetAccountState('alice')).syncEnabled,true);
assert.equal((await restoringStore.readAiringOffsetAccountState('bob')).syncEnabled,false);
restoring.dispose();

// 关闭后立即重开：旧轮次即使晚于新轮次返回，也不能覆盖新 generation 的结果。
reset();configurations.set('alice',config);
const quickStore=await loadStore(),quickOldGet=deferred();let quickReads=0;
const quick=createAiringOffsetSyncManager({...localDeps(quickStore),createStorage:()=>({
 read:async()=>{quickReads++;if(quickReads===1)return quickOldGet.promise;return {content:document('alice',{'70':record(7,'current-generation')}),etag:'"new"'};},write:async()=>{},
})});
await quick.setAccount('alice');await quick.setEnabled(true);
const quickOldRound=quick.syncNow();await waitFor(()=>quickReads===1);
await quick.setEnabled(false);await quick.setEnabled(true);await quick.syncNow();
assert.equal(quickStore.getAiringOffsetsSnapshot()[70],7);
const quickState=await quickStore.readAiringOffsetAccountState('alice'),quickMap=quickStore.getAiringOffsetsSnapshot(),quickStatus=quick.getSnapshot(),quickDisk=disk.get(store.AIRING_OFFSET_ACCOUNTS_STORAGE_KEY);
quickOldGet.resolve({content:document('alice',{'999':record(99,'obsolete-generation')}),etag:'"old"'});
await quickOldRound;await sleep(10);
assert.deepEqual(await quickStore.readAiringOffsetAccountState('alice'),quickState);
assert.equal(disk.get(store.AIRING_OFFSET_ACCOUNTS_STORAGE_KEY),quickDisk);
assert.strictEqual(quickStore.getAiringOffsetsSnapshot(),quickMap);assert.strictEqual(quick.getSnapshot(),quickStatus);
quick.dispose();

// 已排入退避队列的自动重试也必须被总开关取消。
reset();configurations.set('alice',autoConfig);
const retryStore=await loadStore();let disabledRetryReads=0;
const disabledRetry=createAiringOffsetSyncManager({...localDeps(retryStore),debounceMs:1,retryDelays:[40],createStorage:()=>({read:async()=>{disabledRetryReads++;throw Error('fake-secret offline');},write:async()=>{}})});
disabledRetry.setAppActive(true);await disabledRetry.setAccount('alice');await disabledRetry.setEnabled(true);
await waitFor(()=>disabledRetry.getSnapshot().phase==='error');
assert.equal(disabledRetryReads,1);
await disabledRetry.setEnabled(false);await sleep(70);
assert.equal(disabledRetryReads,1,'关闭清除退避定时器，不再重试网络');
assert.equal(disabledRetry.getSnapshot().phase,'idle');disabledRetry.dispose();
// 跨窗口仅改总开关也必须被 manager 观察；运行真实 store 的 storage 通知路径。
const externalEnabled=(local,enabled)=>{
 const key=local.AIRING_OFFSET_ACCOUNTS_STORAGE_KEY;
 const data=JSON.parse(disk.get(key));
 data.accounts['account:alice'].syncEnabled=enabled;
 disk.set(key,JSON.stringify(data));
 for(const listener of storageListeners)listener({key,storageArea:storage,newValue:'old-event-value'});
};
reset();configurations.set('alice',autoConfig);
const windowStore=await loadStore(),windowGet=deferred();let windowReads=0,windowWrites=0,holdWindowReads=true;
const windowSignals=[];
const windows=createAiringOffsetSyncManager({...localDeps(windowStore),debounceMs:1,retryDelays:[40],createStorage:credentials=>({
 read:async signal=>{windowReads++;windowSignals.push(signal);if(holdWindowReads)return windowGet.promise;assert.equal(credentials.password,'rotated-fake-secret','重开后的实际网络必须使用重新恢复的凭证');return null;},
 write:async()=>{windowWrites++;},
})});
await windows.setAccount('alice');await windows.setEnabled(true);
windows.setAppActive(true);await waitFor(()=>windowReads===1);
const windowRound=windows.syncNow();
const windowProbe=assert.rejects(windows.testConnection(autoConfig),/取消|变化/);
await waitFor(()=>windowReads===2);
const windowBefore=await windowStore.readAiringOffsetAccountState('alice');
externalEnabled(windowStore,false);
await waitFor(()=>windows.getSnapshot().enabled===false);
assert(windowSignals.every(signal=>signal.aborted),'另一窗口关闭总开关中止在途轮次和只读探测');
await windowRound;await windowProbe;
assert.equal(windows.getSnapshot().phase,'idle');
await assert.rejects(windows.syncNow(),/开启/);
await assert.rejects(windows.testConnection(autoConfig),/开启/);
const windowClosedDisk=disk.get(windowStore.AIRING_OFFSET_ACCOUNTS_STORAGE_KEY),windowClosedStatus=windows.getSnapshot();
windowGet.resolve({content:document('alice',{'999':record(9,'late-other-window')}),etag:'"obsolete"'});
await sleep(15);
assert.equal(disk.get(windowStore.AIRING_OFFSET_ACCOUNTS_STORAGE_KEY),windowClosedDisk,'被跨窗口关闭取消的候选不能落盘');
assert.strictEqual(windows.getSnapshot(),windowClosedStatus,'迟到候选不能发布旧 generation 状态');
assert.equal(windowWrites,0);
assert.deepEqual(await windowStore.readAiringOffsetAccountState('alice'),{...windowBefore,syncEnabled:false});
windowStore.setAiringOffsetDays(80,8);
windows.setAppActive(false);windows.setAppActive(true);await sleep(15);
assert.equal(windowReads,2,'关闭期间本地保存与前台变化不联网');
// 重新启用读取安全配置，不复用另一窗口可能已更新的旧凭证或 autoSync。
configurations.set('alice',{...config,password:'rotated-fake-secret'});
holdWindowReads=false;
const beforeExternalEnableWrites=io.writes;
externalEnabled(windowStore,true);
await waitFor(()=>windows.getSnapshot().enabled&&windows.getSnapshot().autoSync===false);
await sleep(10);assert.equal(windowReads,2,'外部重新启用按新 autoSync=false 恢复，仅开放手动同步');
assert.equal(io.writes,beforeExternalEnableWrites,'观察偏好不能递归调用 setEnabled 重写数据库');
assert.equal((await windows.getConfig()).password,'rotated-fake-secret');
await windows.syncNow();assert.equal(windowReads,3);assert.equal(windowWrites,1);
windows.dispose();

reset();configurations.set('alice',autoConfig);
const windowRetryStore=await loadStore();let windowRetryReads=0;
const windowRetry=createAiringOffsetSyncManager({...localDeps(windowRetryStore),debounceMs:1,retryDelays:[60],createStorage:()=>({
 read:async()=>{windowRetryReads++;throw Error('offline');},write:async()=>{},
})});
windowRetry.setAppActive(true);await windowRetry.setAccount('alice');await windowRetry.setEnabled(true);
await waitFor(()=>windowRetry.getSnapshot().phase==='error');
externalEnabled(windowRetryStore,false);await waitFor(()=>!windowRetry.getSnapshot().enabled);
await sleep(90);assert.equal(windowRetryReads,1,'另一窗口关闭也清除已排队退避重试');
windowRetry.dispose();

// 模拟持久化先通知，再延迟返回：自身写入不能被当成外部修改而取消自身。
reset();configurations.set('alice',config);
const ownNotifyStore=await loadStore();let ownWriteGate=null,ownWrites=0;
const ownNotify=createAiringOffsetSyncManager({...localDeps(ownNotifyStore),updateLocal:async(account,update)=>{
 ownWrites++;const result=await ownNotifyStore.updateAiringOffsetAccountState(account,update);
 if(ownWriteGate){ownWriteGate.started.resolve();await ownWriteGate.done.promise;}
 return result;
}});
await ownNotify.setAccount('alice');
for(const enabled of [true,false,true]){
 ownWriteGate={started:deferred(),done:deferred()};
 const ownChange=ownNotify.setEnabled(enabled);await ownWriteGate.started.promise;await sleep(5);
 ownWriteGate.done.resolve();await ownChange;ownWriteGate=null;
 assert.equal(ownNotify.getSnapshot().enabled,enabled,'自身持久化通知不使调用失效');
 assert.equal((await ownNotifyStore.readAiringOffsetAccountState('alice')).syncEnabled,enabled);
}
assert.equal(ownWrites,3,'自身通知不会递归保存开关');
// 写入已完成但 API 尚未返回时，另一窗口的新确认值优先，即使它等于旧 status。
ownWriteGate={started:deferred(),done:deferred()};
const pendingOwnClose=ownNotify.setEnabled(false);await ownWriteGate.started.promise;
externalEnabled(ownNotifyStore,true);await sleep(10);
ownWriteGate.done.resolve();await pendingOwnClose;ownWriteGate=null;
assert.equal(ownNotify.getSnapshot().enabled,true,'外部更新不能被较早的自身保存返回值回滚');
assert.equal((await ownNotifyStore.readAiringOffsetAccountState('alice')).syncEnabled,true);
ownNotify.dispose();

// 外部开启恢复安全配置期间再被关闭或切账号，迟到配置不能重开网络。
reset();configurations.set('alice',autoConfig);
const windowRestoreStore=await loadStore();let windowConfigGate=null,windowRestoreReads=0;
const windowRestore=createAiringOffsetSyncManager({...localDeps(windowRestoreStore),debounceMs:1,
 configs:{...managerDeps.configs,get:async account=>{
  if(account==='alice'&&windowConfigGate){windowConfigGate.started.resolve();return windowConfigGate.done.promise;}
  return configurations.get(account)??null;
 }},
 createStorage:()=>({read:async()=>{windowRestoreReads++;return null;},write:async()=>{}}),
});
windowRestore.setAppActive(true);await windowRestore.setAccount('alice');
windowConfigGate={started:deferred(),done:deferred()};
externalEnabled(windowRestoreStore,true);await windowConfigGate.started.promise;
externalEnabled(windowRestoreStore,false);await waitFor(()=>!windowRestore.getSnapshot().enabled);
windowConfigGate.done.resolve(autoConfig);await sleep(10);
assert.equal(windowRestore.getSnapshot().enabled,false);assert.equal(windowRestoreReads,0);
windowConfigGate={started:deferred(),done:deferred()};
externalEnabled(windowRestoreStore,true);await windowConfigGate.started.promise;
await windowRestore.setAccount('bob');windowConfigGate.done.resolve(autoConfig);await sleep(10);
assert.equal(windowRestore.getSnapshot().account,'bob');assert.equal(windowRestore.getSnapshot().enabled,false);
assert.equal(windowRestoreReads,0,'外部偏好读取的迟到配置仍受账号与 generation 隔离');
windowRestore.dispose();
console.log('offset sync manager: 合并、冲突、并发保存、CAS、离线重试、自动触发、前后台、默认关闭、跨窗口偏好、自身通知、取消与账号隔离通过 ✓');
