import { get, run, all, setSetting } from './db.js';
import { hashSecret } from './crypto.js';

const [cmd, ...args] = process.argv.slice(2);

const help = `NEXUS admin CLI
  npm run cli -- users                          list accounts
  npm run cli -- reset-password <email> <new>   set a new password (min 8 chars) and sign that user out everywhere
  npm run cli -- signup on|off                  allow / close public sign-ups
`;

switch (cmd) {
  case 'users':
    for (const u of all('SELECT email, name, is_admin FROM users ORDER BY id')) {
      console.log(`${u.is_admin ? 'owner' : 'member'}  ${u.email}  (${u.name})`);
    }
    break;
  case 'reset-password': {
    const [email, pw] = args;
    if (!email || !pw || pw.length < 8) { console.error('Usage: reset-password <email> <new password, 8+ chars>'); process.exit(1); }
    const u = get('SELECT id FROM users WHERE email = ?', email.toLowerCase());
    if (!u) { console.error('No such user'); process.exit(1); }
    run('UPDATE users SET pass_hash = ? WHERE id = ?', await hashSecret(pw), u.id);
    run('DELETE FROM sessions WHERE user_id = ?', u.id);
    console.log('Password updated; existing sessions were signed out.');
    break;
  }
  case 'signup':
    if (!['on', 'off'].includes(args[0])) { console.error('Usage: signup on|off'); process.exit(1); }
    setSetting('open_signup', args[0] === 'on' ? '1' : '0');
    console.log(`Public sign-up is now ${args[0]}.`);
    break;
  default:
    console.log(help);
}
