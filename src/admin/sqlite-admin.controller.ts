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
 * SQLite Admin — integrated read-only browser embedded in the gateway.
 *
 * Serves a single-page HTML UI at `/admin/db` with:
 *   - Login screen asking for API key
 *   - Sidebar: table list with row counts, clickable to browse
 *   - SQL query editor with Ctrl+Enter shortcut
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
      '<span style="color:#484f58">Read-only</span>';}
  catch(e){if(e.message!=='unauthorized')document.getElementById('meta').innerHTML='<span style="color:#f85149">err</span>';}}

async function list(){
  try{const d=await(await api(API+'/tables')).json();tables=d.tables;
    const s=document.getElementById('tbl'),t=document.getElementById('tables');
    s.innerHTML='<option value="">table...</option>';t.innerHTML='';
    tables.forEach(function(tbl){const o=document.createElement('option');o.value=tbl.name;o.textContent=tbl.name+(tbl.c?' ('+tbl.c+')':'');s.appendChild(o);
      const d2=document.createElement('div');d2.className='t';d2.textContent=tbl.name+(tbl.c?' ('+tbl.c+')':'');
      d2.onclick=function(){document.getElementById('sql').value='SELECT * FROM "'+tbl.name+'" LIMIT 200;';runQuery();};
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
            const rows = stmt.all() as Record<string, unknown>[];
            const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
            return { rows, columns, duration: Date.now() - t0 };
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