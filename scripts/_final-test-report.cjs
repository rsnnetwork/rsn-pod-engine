require('dotenv').config({path:'server/.env'});
const {Client}=require('pg');
const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});

(async()=>{
  await c.connect();

  // Pull the main 'test' event from the last hour
  const main = await c.query(
    "SELECT id, title, status::text AS status, current_round, started_at, ended_at, lobby_room_id, host_user_id FROM sessions WHERE title = 'test' AND started_at > NOW() - INTERVAL '2 hours' ORDER BY started_at DESC LIMIT 3"
  );
  console.log('MAIN_RUNS (last 2h title=test):');
  for (const r of main.rows) {
    const sid = r.id;
    const p = await c.query('SELECT COUNT(*) AS n FROM session_participants WHERE session_id=$1', [sid]);
    const m = await c.query('SELECT COUNT(*) AS n FROM matches WHERE session_id=$1', [sid]);
    const rt = await c.query('SELECT COUNT(*) AS n FROM ratings r JOIN matches m ON m.id=r.match_id WHERE m.session_id=$1', [sid]);
    const dur = r.ended_at && r.started_at ? Math.round((r.ended_at - r.started_at)/1000) : null;
    console.log('  ' + sid.slice(0,8) + ' ' + r.status + ' r' + r.current_round +
      ' | participants=' + p.rows[0].n +
      ' | matches=' + m.rows[0].n +
      ' | ratings=' + rt.rows[0].n +
      ' | dur=' + (dur ? Math.round(dur/60) + 'm' : '?') +
      ' | lobby_rm=' + (r.lobby_room_id ? 'PRESENT' : 'NULL'));
  }

  // The e1 event status
  const e1 = await c.query(
    "SELECT id, title, status::text AS status, current_round, lobby_room_id, created_at FROM sessions WHERE title = 'e1' ORDER BY created_at DESC LIMIT 1"
  );
  if (e1.rows.length) {
    const r = e1.rows[0];
    const p = await c.query("SELECT COUNT(*) AS n FROM session_participants WHERE session_id=$1 AND status NOT IN ('removed','left','no_show')", [r.id]);
    console.log('\nE1_LOBBY:');
    console.log('  ' + r.id.slice(0,8) + ' "' + r.title + '" ' + r.status + '/r' + r.current_round +
      ' | active_participants=' + p.rows[0].n +
      ' | lobby_rm=' + (r.lobby_room_id ? 'PRESENT' : 'NULL') +
      ' | created=' + r.created_at.toISOString());
  }

  // Any orphans?
  const orph = await c.query('SELECT COUNT(*) AS n FROM session_participants sp LEFT JOIN sessions s ON s.id=sp.session_id WHERE s.id IS NULL');
  console.log('\nORPHAN_PARTICIPANTS=' + orph.rows[0].n);

  await c.end();
})().catch(e=>{console.error('ERR', e.message);process.exit(1)});
