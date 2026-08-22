import {
    Body,
    Controller,
    Get,
    Header,
    Post,
    UseGuards,
} from '@nestjs/common';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RequireScopesGuard } from '../auth/require-scopes.guard';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { DatabaseService } from '../database/database.service';
import { statSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * SQLite Admin — integrated read/write browser embedded in the gateway.
 *
 * Serves a single-page HTML UI at `/admin/db` with:
 *   - Login screen asking for API key
 *   - Sidebar: table list with row counts, clickable to browse
 *   - SQL query editor with Ctrl+Enter shortcut
 *   - CRUD Forms tab for insert/update/delete on key tables
 *   - Results table with auto-column detection
 *   - File metadata (size, table count)
 *
 * The HTML page is public; all API endpoints (tables, query, stats)
 * are guarded by ApiKeyAuthGuard + RequireScopes('admin'). The UI
 * stores the key in sessionStorage and sends it as
 * `Authorization: Bearer <key>` on every fetch.
 */

const HTML = (): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SQLite Admin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'SF Mono',Monaco,Consolas,'Cascadia Code',monospace;font-size:13px;background:#0d1117;color:#c9d1d9}
h2{font-size:14px;color:#58a6ff;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #30363d}

/* login */
#login{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0d1117;z-index:99}
#login input{background:#161b22;color:#c9d1d9;border:1px solid #30363d;padding:8px 12px;font-family:inherit;font-size:14px;border-radius:6px;width:320px}
#login button{margin-left:8px;background:#238636;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:14px;font-weight:500}
#login button:hover{background:#2ea043}
#login .err{color:#f85149;font-size:12px;margin-top:6px;text-align:center}

/* app */
#app{display:flex;height:100vh}
#sidebar{width:230px;min-width:230px;background:#161b22;border-right:1px solid #30363d;padding:12px;overflow-y:auto;display:flex;flex-direction:column}
#sidebar h3{font-size:11px;color:#8b949e;margin:8px 0 4px;text-transform:uppercase;letter-spacing:.5px}
#sidebar .t{display:block;padding:2px 4px;cursor:pointer;border-radius:3px}
#sidebar .t:hover{background:#1c2128;color:#58a6ff}
#main{flex:1;display:flex;flex-direction:column;min-width:0}
#toolbar{padding:6px 12px;background:#161b22;border-bottom:1px solid #30363d;display:flex;gap:8px;align-items:center}
#toolbar button{background:#238636;color:#fff;border:none;padding:4px 14px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:500}
#toolbar button:hover{background:#2ea043}
#editor-wrap{background:#0d1117;border-bottom:1px solid #30363d}
#sql{width:100%;min-height:56px;max-height:180px;background:transparent;color:#c9d1d9;border:none;outline:none;padding:8px 14px;font-family:inherit;font-size:13px;line-height:1.6;resize:vertical}
#results-wrap{flex:1;overflow:auto;padding:0}
table.d{border-collapse:collapse;width:100%;font-size:12px}
table.d th{position:sticky;top:0;background:#161b22;color:#58a6ff;padding:4px 10px;text-align:left;border-bottom:2px solid #30363d;white-space:nowrap;font-weight:500}
table.d td{padding:3px 10px;border-bottom:1px solid #21262d;white-space:nowrap;max-width:400px;overflow:hidden;text-overflow:ellipsis}
table.d tr:hover td{background:#161b22}
table.d .n{color:#79c0ff}
table.d .b{color:#ff7b72}
table.d .s{color:#a5d6ff}
#status{padding:4px 14px;font-size:11px;border-top:1px solid #30363d;color:#8b949e;background:#161b22}
select{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;padding:2px 6px;font-family:inherit;font-size:12px;border-radius:3px}
#meta{font-size:11px;color:#484f58;margin-top:4px;padding-top:6px;border-top:1px solid #30363d;line-height:1.6}
.hide{display:none!important}

/* tabs */
.tabs{display:flex;gap:0;border-bottom:1px solid #30363d;background:#161b22}
.tab{padding:6px 16px;cursor:pointer;font-size:12px;color:#8b949e;border-bottom:2px solid transparent;user-select:none}
.tab:hover{color:#c9d1d9}
.tab.active{color:#58a6ff;border-bottom-color:#58a6ff}

/* crud forms */
#crud-wrap{padding:12px 14px;overflow-y:auto;flex:1}
#crud-wrap label{display:block;font-size:11px;color:#8b949e;margin-bottom:2px;margin-top:8px}
#crud-wrap label:first-child{margin-top:0}
#crud-wrap input,#crud-wrap select{background:#161b22;color:#c9d1d9;border:1px solid #30363d;padding:5px 8px;font-family:inherit;font-size:12px;border-radius:4px;width:100%;margin-bottom:2px}
#crud-wrap input:focus,#crud-wrap select:focus{border-color:#58a6ff;outline:none}
.crud-btns{display:flex;gap:6px;margin-top:12px;flex-wrap:wrap}
.crud-btns button{border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:11px;font-weight:500}
.btn-create{background:#238636;color:#fff}.btn-create:hover{background:#2ea043}
.btn-read{background:#1f6feb;color:#fff}.btn-read:hover{background:#388bfd}
.btn-update{background:#9e6a03;color:#fff}.btn-update:hover{background:#bb8009}
.btn-delete{background:#da3633;color:#fff}.btn-delete:hover{background:#f85149}
.btn-list{background:#30363d;color:#c9d1d9}.btn-list:hover{background:#484f58}
#crud-status{margin-top:8px;font-size:11px;color:#8b949e}
#crud-status.ok{color:#3fb950}
#crud-status.err{color:#f85149}
</style>
</head>
<body>

<div id="login">
  <div style="text-align:center">
    <h2 style="margin-top:0;border:none;padding:0;margin-bottom:16px">SQLite Admin</h2>
    <div style="display:flex">
      <input id="key-input" type="password" placeholder="API key (sk-...)" onkeydown="if(event.key==='Enter')login()">
      <button onclick="login()">Login</button>
    </div>
    <div id="login-err" class="err"></div>
  </div>
</div>

<div id="app" class="hide">
  <div id="sidebar">
    <h2>SQLite Admin</h2>
    <div id="meta" class="l">loading...</div>
    <h3>Tables</h3>
    <div id="tables"></div>
  </div>
  <div id="main">
    <div class="tabs">
      <div class="tab active" onclick="switchTab('sql')">SQL Editor</div>
      <div class="tab" onclick="switchTab('crud')">CRUD Forms</div>
    </div>
    <div id="sql-panel">
    <div id="toolbar">
      <button id="run" onclick="runQuery()">▶ Run</button>
      <span id="rc"></span>
      <span style="flex:1"></span>
      <select id="tbl" onchange="onTable()"><option value="">table...</option></select>
    </div>
    <div id="editor-wrap"><textarea id="sql" spellcheck="false" placeholder="Ctrl+Enter to run">SELECT * FROM providers LIMIT 10;</textarea></div>
    <div id="results-wrap"></div>
    <div id="status">ready</div>
    </div>
    <div id="crud-panel" class="hide">
      <div id="crud-wrap">
        <h2 style="margin-top:0">CRUD Forms</h2>
        <label>Table</label>
        <select id="crud-table" onchange="renderCrudForm()">
          <option value="">Select table...</option>
          <option value="alias_entries">alias_entries</option>
          <option value="alias_policy">alias_policy</option>
          <option value="alias_weights">alias_weights</option>
          <option value="clients">clients</option>
          <option value="model_configs">model_configs</option>
        </select>
        <div id="crud-form"></div>
        <div id="crud-status"></div>
        <div id="crud-results"></div>
      </div>
    </div>
  </div>
</div>

<script>
const API='/admin/db';
let key=sessionStorage.getItem('sqlite_key');
let tables=[];

function authHeaders(){
  const h={'Content-Type':'application/json'};
  if(key)h['Authorization']='Bearer '+key;
  return h;
}

async function api(url,opts){
  const r=await fetch(url,{...opts,headers:{...authHeaders(),...((opts&&opts.headers)||{})}});
  if(r.status===401||r.status===403){
    sessionStorage.removeItem('sqlite_key');
    key=null;
    document.getElementById('login').classList.remove('hide');
    document.getElementById('app').classList.add('hide');
    document.getElementById('login-err').textContent=key?'Session expired — re-enter API key':'';
    throw new Error('unauthorized');
  }
  return r;
}

async function login(){
  const k=document.getElementById('key-input').value.trim();
  if(!k)return;
  document.getElementById('login-err').textContent='';
  key=k;
  try{
    const test=await api(API+'/tables');
    if(!test.ok)throw new Error('invalid');
    sessionStorage.setItem('sqlite_key',k);
    document.getElementById('login').classList.add('hide');
    document.getElementById('app').classList.remove('hide');
    list();info();
  }catch(e){
    document.getElementById('login-err').textContent='Invalid API key or not authorized';
    key=null;
  }
}

// Auto-login if key exists in sessionStorage
if(key){
  (async()=>{
    try{
      const test=await api(API+'/tables');
      if(test.ok){
        document.getElementById('login').classList.add('hide');
        document.getElementById('app').classList.remove('hide');
        list();info();
      }
    }catch(e){}
  })();
}

async function info(){
  try{const d=await(await api(API+'/stats')).json();
    document.getElementById('meta').innerHTML=
      '<span style="color:#8b949e">'+d.file+'</span><br>'+
      '<span style="color:#8b949e">Size: '+d.size+'</span><br>'+
      '<span style="color:#8b949e">Tables: '+d.count+'</span><br>'+
      '<span style="color:#3fb950">Read/Write</span>';}
  catch(e){if(e.message!=='unauthorized')document.getElementById('meta').innerHTML='<span style="color:#f85149">err</span>';}}

async function list(){
  try{const d=await(await api(API+'/tables')).json();tables=d.tables;
    const s=document.getElementById('tbl'),t=document.getElementById('tables');
    s.innerHTML='<option value="">table...</option>';t.innerHTML='';
    tables.forEach(function(tbl){const o=document.createElement('option');o.value=tbl.name;o.textContent=tbl.name+(tbl.c?' ('+tbl.c+')':'');s.appendChild(o);
      const d2=document.createElement('div');d2.className='t';d2.textContent=tbl.name+(tbl.c?' ('+tbl.c+')':'');
      d2.onclick=function(){
        var sel=document.getElementById('crud-table');
        if(sel.querySelector('option[value="'+tbl.name+'"]')){
          sel.value=tbl.name;switchTab('crud');renderCrudForm();crudList();
        }else{
          document.getElementById('sql').value='SELECT * FROM "'+tbl.name+'" LIMIT 200;';switchTab('sql');runQuery();
        }
      };
      t.appendChild(d2);});}
  catch(e){if(e.message!=='unauthorized')document.getElementById('tables').innerHTML='<span style="color:#f85149">err</span>';}}

const esc=function(s){return s===null||s===undefined?'<span style="color:#484f58">NULL</span>':String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};
const cls=function(v){return typeof v==='number'?'n':typeof v==='boolean'?'b':'s';};

function render(rows,cols,msg,dur){
  const el=document.getElementById('results-wrap'),rc=document.getElementById('rc'),st=document.getElementById('status');
  if(!rows.length){el.innerHTML=msg||'<div style="padding:20px;color:#484f58">no results</div>';rc.textContent='';st.textContent=msg?'error: '+msg:'done - 0 rows'+(dur?' ('+dur+'ms)':'');return;}
  var i,j,h='<table class="d"><thead><tr>';
  for(i=0;i<cols.length;i++){h+='<th>'+esc(cols[i])+'</th>';}
  h+='</tr></thead><tbody>';
  for(i=0;i<rows.length;i++){h+='<tr>';for(j=0;j<cols.length;j++){h+='<td class="'+cls(rows[i][cols[j]])+'">'+esc(rows[i][cols[j]])+'</td>';}h+='</tr>';}
  h+='</tbody></table>';el.innerHTML=h;rc.textContent=rows.length+' rows';st.textContent='ok - '+rows.length+' rows'+(dur?' ('+dur+'ms)':'');
}

async function runQuery(){
  const sql=document.getElementById('sql').value.trim();if(!sql)return;
  const t0=Date.now();
  try{const r=await api(API+'/query',{method:'POST',body:JSON.stringify({sql})});
    const d=await r.json();d.error?(document.getElementById('status').textContent='error: '+d.error):render(d.rows,d.columns,null,d.duration);}
  catch(e){if(e.message!=='unauthorized')render([],[],e.message,t0);}
}

function onTable(){const n=document.getElementById('tbl').value;if(!n)return;
  document.getElementById('sql').value='SELECT * FROM "'+n+'" LIMIT 200;';runQuery();}

document.getElementById('sql').addEventListener('keydown',function(e){if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();runQuery();}});

// ─── Tab switching ───
function switchTab(t){
  document.querySelectorAll('.tab').forEach(function(el,i){
    el.classList.toggle('active',(t==='sql'&&i===0)||(t==='crud'&&i===1));
  });
  document.getElementById('sql-panel').classList.toggle('hide',t!=='sql');
  document.getElementById('crud-panel').classList.toggle('hide',t!=='crud');
}

// ─── CRUD form definitions ───
var TABLES={
  alias_entries:{
    cols:[
      {name:'alias_name',label:'Alias',type:'text',pk:true},
      {name:'position',label:'Position',type:'number',pk:true},
      {name:'provider_id',label:'Provider ID',type:'text'},
      {name:'model_key',label:'Model Key',type:'text'},
      {name:'priority',label:'Priority',type:'number',def:0}
    ]
  },
  alias_policy:{
    cols:[
      {name:'alias_key',label:'Alias Key',type:'text',pk:true},
      {name:'strategy',label:'Strategy',type:'select',opts:['primary','round-robin','fallback','weighted','priority-grouped'],def:'primary'}
    ]
  },
  alias_weights:{
    cols:[
      {name:'alias_key',label:'Alias Key',type:'text',pk:true},
      {name:'position',label:'Position',type:'number',pk:true},
      {name:'weight',label:'Weight',type:'number',def:1}
    ]
  },
  clients:{
    cols:[
      {name:'id',label:'ID',type:'text',pk:true},
      {name:'name',label:'Name',type:'text'},
      {name:'scopes',label:'Scopes',type:'text',def:'chat.read,chat.write'},
      {name:'rate_limit_rpm',label:'Rate Limit RPM',type:'number',def:60},
      {name:'rate_limit_tpm',label:'Rate Limit TPM',type:'number'}
    ]
  },
  model_configs:{
    cols:[
      {name:'provider_id',label:'Provider ID',type:'text',pk:true},
      {name:'model_key',label:'Model Key',type:'text',pk:true},
      {name:'real_name',label:'Real Name',type:'text'},
      {name:'max_tokens',label:'Max Tokens',type:'number'},
      {name:'supports_stream',label:'Supports Stream',type:'select',opts:[{v:'1',l:'Yes'},{v:'0',l:'No'}],def:'1'},
      {name:'disable_thinking',label:'Disable Thinking',type:'select',opts:[{v:'0',l:'No'},{v:'1',l:'Yes'}],def:'0'}
    ]
  }
};

function renderCrudForm(){
  var tbl=document.getElementById('crud-table').value;
  var el=document.getElementById('crud-form');
  var st=document.getElementById('crud-status');
  st.textContent='';st.className='crud-status';
  if(!tbl||!TABLES[tbl]){el.innerHTML='';return;}
  var t=TABLES[tbl],h='';
  t.cols.forEach(function(c){
    h+='<label>'+c.label+'</label>';
    if(c.type==='select'){
      h+='<select id="cf-'+c.name+'">';
      (c.opts||[]).forEach(function(o){
        var v=typeof o==='object'?o.v:o,l=typeof o==='object'?o.l:o;
        h+='<option value="'+v+'"'+(v===(c.def||'')?' selected':'')+'>'+l+'</option>';
      });
      h+='</select>';
    }else{
      h+='<input id="cf-'+c.name+'" type="'+c.type+'" placeholder="'+c.label+'"'+(c.def!==undefined?' value="'+c.def+'"':'')+'>';
    }
  });
  h+='<div class="crud-btns">';
  h+='<button class="btn-list" onclick="crudList()">List All</button>';
  h+='<button class="btn-read" onclick="crudRead()">Load (by PK)</button>';
  h+='<button class="btn-create" onclick="crudCreate()">Insert</button>';
  h+='<button class="btn-update" onclick="crudUpdate()">Update (by PK)</button>';
  h+='<button class="btn-delete" onclick="crudDelete()">Delete (by PK)</button>';
  h+='</div>';
  el.innerHTML=h;
}

function getCfVal(name){var el=document.getElementById('cf-'+name);return el?el.value.trim():'';}

function crudStatus(msg,ok){
  var st=document.getElementById('crud-status');
  st.textContent=msg;st.className=ok?'ok':'err';
}

async function crudExec(sql,label){
  try{
    var r=await api(API+'/query',{method:'POST',body:JSON.stringify({sql:sql})});
    var d=await r.json();
    if(d.error){crudStatus(label+' error: '+d.error,false);return null;}
    crudStatus(label+' ok'+(d.rows.length?' — '+d.rows.length+' rows':'')+(d.duration?' ('+d.duration+'ms)':''),true);
    return d;
  }catch(e){if(e.message!=='unauthorized')crudStatus(label+' error: '+e.message,false);return null;}
}

async function crudList(){
  var tbl=document.getElementById('crud-table').value;if(!tbl)return;
  try{
    var r=await api(API+'/query',{method:'POST',body:JSON.stringify({sql:'SELECT * FROM "'+tbl+'" ORDER BY rowid LIMIT 200;'})});
    var d=await r.json();
    if(d.error){crudStatus('List error: '+d.error,false);return;}
    renderCrudResults(d.rows,d.columns);
    crudStatus(d.rows.length+' rows loaded — click a row to edit',true);
  }catch(e){if(e.message!=='unauthorized')crudStatus('List error: '+e.message,false);}
}

function renderCrudResults(rows,cols){
  var el=document.getElementById('crud-results');
  if(!el)return;
  if(!rows.length){el.innerHTML='<div style="padding:10px;color:#484f58">empty table</div>';return;}
  var i,j,h='<table class="d" style="margin-top:10px"><thead><tr>';
  for(i=0;i<cols.length;i++){h+='<th>'+esc(cols[i])+'</th>';}
  h+='</tr></thead><tbody>';
  for(i=0;i<rows.length;i++){
    h+='<tr class="crud-row" data-idx="'+i+'" style="cursor:pointer">';
    for(j=0;j<cols.length;j++){h+='<td class="'+cls(rows[i][cols[j]])+'">'+esc(rows[i][cols[j]])+'</td>';}
    h+='</tr>';
  }
  h+='</tbody></table>';el.innerHTML=h;
  el.querySelectorAll('.crud-row').forEach(function(tr){
    tr.addEventListener('click',function(){fillCrudForm(rows[parseInt(tr.dataset.idx)]);});
  });
}

function fillCrudForm(row){
  var tbl=document.getElementById('crud-table').value;if(!tbl||!TABLES[tbl])return;
  TABLES[tbl].cols.forEach(function(c){
    var el=document.getElementById('cf-'+c.name);
    if(el&&row[c.name]!==undefined&&row[c.name]!==null)el.value=row[c.name];
  });
  crudStatus('Row loaded into form — edit and Update/Delete',true);
}

async function crudRead(){
  var tbl=document.getElementById('crud-table').value;if(!tbl||!TABLES[tbl])return;
  var t=TABLES[tbl],wh=[];
  t.cols.forEach(function(c){if(c.pk){var v=getCfVal(c.name);if(v)wh.push('"'+c.name+'"='+(c.type==='number'?v:"'"+v.replace(/'/g,"''")+"'"));}});
  if(!wh.length){crudStatus('Fill at least one PK field',false);return;}
  var sql='SELECT * FROM "'+tbl+'" WHERE '+wh.join(' AND ')+' LIMIT 50;';
  var d=await crudExec(sql,'Read');
  if(d&&d.rows.length){render(d.rows,d.columns,null,d.duration);}
}

async function crudCreate(){
  var tbl=document.getElementById('crud-table').value;if(!tbl||!TABLES[tbl])return;
  var t=TABLES[tbl],cols=[],vals=[];
  t.cols.forEach(function(c){var v=getCfVal(c.name);if(v){cols.push('"'+c.name+'"');vals.push(c.type==='number'?v:"'"+v.replace(/'/g,"''")+"'");}});
  if(!cols.length){crudStatus('Fill at least one field',false);return;}
  var sql='INSERT INTO "'+tbl+'" ('+cols.join(',')+') VALUES ('+vals.join(',')+');';
  await crudExec(sql,'Insert');
}

async function crudUpdate(){
  var tbl=document.getElementById('crud-table').value;if(!tbl||!TABLES[tbl])return;
  var t=TABLES[tbl],sets=[],wh=[];
  t.cols.forEach(function(c){var v=getCfVal(c.name);if(c.pk){if(v)wh.push('"'+c.name+'"='+(c.type==='number'?v:"'"+v.replace(/'/g,"''")+"'"));}else if(v){sets.push('"'+c.name+'"='+(c.type==='number'?v:"'"+v.replace(/'/g,"''")+"'"));}});
  if(!wh.length){crudStatus('Fill at least one PK field',false);return;}
  if(!sets.length){crudStatus('Fill at least one non-PK field to update',false);return;}
  var sql='UPDATE "'+tbl+'" SET '+sets.join(',')+' WHERE '+wh.join(' AND ')+';';
  await crudExec(sql,'Update');
}

async function crudDelete(){
  var tbl=document.getElementById('crud-table').value;if(!tbl||!TABLES[tbl])return;
  var t=TABLES[tbl],wh=[];
  t.cols.forEach(function(c){if(c.pk){var v=getCfVal(c.name);if(v)wh.push('"'+c.name+'"='+(c.type==='number'?v:"'"+v.replace(/'/g,"''")+"'"));}});
  if(!wh.length){crudStatus('Fill at least one PK field',false);return;}
  if(!confirm('Delete from '+tbl+' WHERE '+wh.join(' AND ')+'?'))return;
  var sql='DELETE FROM "'+tbl+'" WHERE '+wh.join(' AND ')+';';
  await crudExec(sql,'Delete');
}
</script></body></html>`;

// ─── Types ──────────────────────────────────────────────────────────────

interface TableItem { name: string; c: number; }
interface QueryReq { sql: string; }
interface QueryResp { rows: Record<string, unknown>[]; columns: string[]; duration?: number; error?: string; }
interface StatsResp { file: string; size: string; count: number; scope: string; }

// ─── Controller ─────────────────────────────────────────────────────────

@Controller('admin/db')
export class SQLiteAdminController {
    constructor(private readonly dbService: DatabaseService) {}

    /** Serve the embedded SQLite admin UI — public (no auth guard) */
    @Get()
    @Header('Content-Type', 'text/html; charset=utf-8')
    ui(): string {
        return HTML();
    }

    /** List tables with row counts */
    @Get('tables')
    @UseGuards(ApiKeyAuthGuard, RequireScopesGuard)
    @RequireScopes('admin')
    tables(): { tables: TableItem[] } {
        const rows = this.dbService.db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' ORDER BY name"
        ).all() as Array<{ name: string }>;

        const withCounts: TableItem[] = [];
        for (const row of rows) {
            const count = this.dbService.db.prepare(
                `SELECT COUNT(*) AS c FROM "${row.name}"`
            ).get() as { c: number };
            withCounts.push({ name: row.name, c: count.c });
        }

        return { tables: withCounts };
    }

    /** Execute SQL */
    @Post('query')
    @UseGuards(ApiKeyAuthGuard, RequireScopesGuard)
    @RequireScopes('admin')
    query(@Body() body: QueryReq): QueryResp {
        const sql = body?.sql?.trim();
        if (!sql) return { rows: [], columns: [], error: 'empty query' };

        const t0 = Date.now();
        try {
            const stmt = this.dbService.db.prepare(sql);
            if (stmt.reader) {
                const rows = stmt.all() as Record<string, unknown>[];
                const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
                return { rows, columns, duration: Date.now() - t0 };
            }
            const result = stmt.run();
            return {
                rows: [{ changes: result.changes, lastInsertRowid: result.lastInsertRowid }],
                columns: ['changes', 'lastInsertRowid'],
                duration: Date.now() - t0,
            };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { rows: [], columns: [], error: msg };
        }
    }

    /** Database file metadata */
    @Get('stats')
    @UseGuards(ApiKeyAuthGuard, RequireScopesGuard)
    @RequireScopes('admin')
    stats(): StatsResp {
        const filePath = this.dbService.db.name;
        const fname = basename(filePath);
        let size = '?';
        try {
            const st = statSync(filePath);
            const kb = st.size / 1024;
            size = kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb.toFixed(1) + ' KB';
            if (st.size > 1073741824) size = (st.size / 1073741824).toFixed(1) + ' GB';
        } catch {
            size = 'unknown';
        }

        const count = this.dbService.db.prepare(
            "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).get() as { c: number };

        return { file: fname, size, count: count.c, scope: 'admin' };
    }
}