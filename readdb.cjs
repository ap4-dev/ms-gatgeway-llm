const Database = require('better-sqlite3');
const db = new Database('./data/gateway.db', {readonly:true});
for (const t of ['providers','model_configs','aliases','alias_policy','routing_policy','alias_entries','alias_weights']) {
  try {
    console.log('\n== '+t+' ==');
    console.log(JSON.stringify(db.prepare('SELECT * FROM '+t).all(), null, 1));
  } catch(e){ console.log(t+': '+e.message); }
}
db.close();
