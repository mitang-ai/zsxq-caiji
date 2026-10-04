import {build} from 'esbuild';
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));
for(const browser of ['chrome','edge']){
 const out=path.join(root,'dist',browser);await mkdir(out,{recursive:true});
 await build({entryPoints:{ui:path.join(root,'ui.ts'),background:path.join(root,'background.ts')},outdir:out,bundle:true,format:'esm',target:'chrome120',platform:'browser',sourcemap:false,legalComments:'none',minify:false});
 for(const file of ['sidepanel.html','workbench.html','style.css'])await copyFile(path.join(root,file),path.join(out,file));
 const manifest={manifest_version:3,name:'星笺 · 知识星球本机工作台',version:'1.0.0',description:'在自己已登录的知识星球中保存资料，独立本地加工与导出，并显式同步到自己的工作台。',minimum_chrome_version:'120',permissions:['storage','sidePanel','activeTab','scripting'],optional_host_permissions:['https://wx.zsxq.com/*','https://api.zsxq.com/*','https://*/*','http://localhost/*','http://127.0.0.1/*'],background:{service_worker:'background.js',type:'module'},side_panel:{default_path:'sidepanel.html'},action:{default_title:'打开星笺侧栏'},options_page:'workbench.html',content_security_policy:{extension_pages:"script-src 'self'; object-src 'self'"},commands:{'_execute_action':{suggested_key:{default:'Alt+Shift+J'},description:'打开星笺'}}};
 await writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
 console.log('Built '+browser+': '+out);
}
