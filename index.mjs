import { app, BrowserWindow, protocol, net, shell } from 'electron';
import * as fs from 'fs';
import { resolve, dirname } from 'path';
import { pathToFileURL } from 'url';
import { createPublicKey, createHash, verify } from 'crypto';
import { argv, env, platform, exit, cwd } from 'process';
import { spawn } from 'child_process';
import { Readable } from 'stream';

protocol.registerSchemesAsPrivileged([{
	scheme: 'nnm',
	privileges: {
		standard: true,
		secure: true,
		supportFetchAPI: true,
		stream: true,
		corsEnabled: true,
		allowServiceWorkers: true
	}
}]);

const exeDir = dirname(env.PORTABLE_EXECUTABLE_FILE || env.APPIMAGE || resolve(env.FLARE_NUINUI_QUEST_DIR, 'a'));
let mods = [], modFiles = [], untrusted = [], privileged = [], hashPath = resolve(app.getPath('userData'), 'privileged.js.trusted.json'), hashes = [], newHashes = {}, gameExe, modDirectory = resolve(exeDir, 'NuinuiMods'), noMenu = true, inspector, nnm404, nnmReady, version = '1.0.0', trustAll, trusted = [], canOpen = 0, extractorDir;

function createFileRequest(base, url, restrict) {
	if (url.pathname.includes('/../')) return new Response(null, {status: 404});
	const path = resolve(base, url.pathname.substr(1));
	const stat = fs.statSync(path, {throwIfNoEntry: false});
	if (stat?.isFile()) return net.fetch(pathToFileURL(path));
	if (stat?.isDirectory()) return new Response(restrict && mods.length ? JSON.stringify(fs.readdirSync(path).filter(mod => mods.includes(mod))) : JSON.stringify(fs.readdirSync(path)), {headers:{'Content-Type':'application/json'}});
	return new Response(null, {status: 404});
}

let argParseState;

for (const arg of argv) {
	if (argParseState === '--mod-directory' || argParseState === '-d') modDirectory = resolve(cwd(), arg);
	else if (argParseState === '--game' || argParseState === '-g') gameExe = resolve(cwd(), arg);
	else if (argParseState === '--mod' || argParseState === '-m') mods.push(arg);
	else if (argParseState === '--trust' || argParseState === '-t') trusted.push(arg);
	else {
		if (arg === '--menu' || arg === '-b') noMenu = false;
		else if (arg === '--inspector' || arg === '-i') noMenu = !(inspector = true);
		else if (arg === '--trust-all') trustAll = true;
		else if (arg === '--reset-trust') {
			fs.unlinkSync(hashPath);
			exit();
		}
		else if (arg === '--version') {
			console.log('NuinuiMods ' + version);
			exit();
		}
		else if (arg === '--help' || arg === '-h' || arg === '-?' || arg === '/?') {
			console.log(`Usage: NuinuiMods.${(platform === 'win32' ? 'exe' : 'x64')} [OPTION]...

  -g, --game [FILE]
\tThe FLARE NUINUI QUEST executable. Searches in the same directory as the NuinuiMods binary by default.

  -d, --mod-directory [DIRECTORY]
\tThe directory to load mods from. Defaults to next to the NuinuiMods binary.

  -m, --mod [NAME]
\tWhich mods to load, by filename. Can be passed multiple times. If not passed, all mods are loaded.

  -t, --trust [NAME]
\tTrust a mod (by filename) to run privileged code without prompting. Can be passed multiple times.

  --trust-all
\tTrust all loaded mods to run privileged code without prompting. For safety reasons it's recommended to only use this with --mod.

  --reset-trust
\tResets the list of automatically trusted mods for the next launch. Does not start the game.

  -b, --menu
\tLaunches the game with the chrome enabled.

  -i, --inspector
\tLaunches the game with the web inspector open.

  --version
\tPrints the version of NuinuiMods.

  -h, -?, --help
\tPrints this text.`);
			exit();
		}
		else if (arg.startsWith('-')) {
			argParseState = arg;
			continue;
		}
	}
	argParseState = null;
}

if (!gameExe) {
	for (const e of fs.readdirSync(exeDir, {withFileTypes: true})) {
		if (e.isFile() && /^FLARE.?NUINUI.?QUEST(.*\.exe)?$/i.test(e.name) && !/install/i.test(e.name)) {
			if (gameExe) {
				gameExe = null;
				break;
			} else gameExe = resolve(exeDir, e.name);
		}
	}
}

try {
	hashes = JSON.parse(fs.readFileSync(hashPath, 'utf8'));
} catch {}

global.NNM = {
	version,
	modDirectory,
	requestHandlers: {
		game: (_, url) => createFileRequest(global.NNM.baseGameRoot, url),
		mod: (_, url) => createFileRequest(global.NNM.modDirectory, url, url.pathname === '/'),
		nnm: (_, url) => {
			if (url.pathname === '/') {
				if (privileged.length) {
					const newHashes2 = [];
					for (const mod of privileged) {
						newHashes2.push(newHashes[mod]);
						import(resolve(global.NNM.modDirectory, mod, 'privileged.js'));
					}
					privileged = [];
					if (untrusted.length)
						fs.writeFile(hashPath, JSON.stringify(newHashes2), _ => {});
				}
				return net.fetch(import.meta.url.substr(0, import.meta.url.length - 3) + 'html');
			}
			else if (url.pathname === '/untrusted') return new Response(`
<body style="background-color:#000;color:#fff;text-align:center;font-family:sans-serif;font-size:130%">
<h1>WARNING!</h1>
<p>The following mods would like to run code with full privileges:</p>
<div style="padding:1em 0">
${untrusted.map(mod => `<div style="font-family:monospace;font-size:150%">${mod.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`).join('')}
</div>
<p>This means they have <strong style="text-transform:uppercase">full access</strong> to your system!</p>
<p>Only allow this if you really trust them</p>
<p><strong style="background-color:red;border-radius:0.5em;text-transform:uppercase;display:inline-block;width:8em;line-height:3em;cursor:pointer" onclick="location.href='/'">Allow</strong></p>
<div style="background-color:grey;border-radius:0.5em;display:inline-block;width:8em;line-height:2em;cursor:pointer" onclick="fetch('/quit')">Quit</div>
</body>
			`, {headers:{'Content-Type':'text/html'}});
			else if (url.pathname === '/quit') app.quit();
			else if (url.pathname === '/fs/1') NNM.window.setFullScreen(true);
			else if (url.pathname === '/fs/0') NNM.window.setFullScreen(false);
			else if (url.pathname === '/assetwalk') return new Response(JSON.stringify(modFiles));
			else if (url.pathname === '/404') return new Response('<body style="background-color:#000;color:#fff;font-family:sans-serif"><main style="width:50vw;margin:20vh 0 0 25vw"><p>'+nnm404, {headers:{'Content-Type':'text/html'}});
			else if (url.pathname === '/open') {
				if (Date.now() < canOpen) return new Response(null, {status: 429});
				const link = url.searchParams.get('link');
				if (!URL.parse(link)) return new Response(null, {status: 400});
				if (!link.startsWith('http://') && !link.startsWith('https://')) return new Response(null, {status: 403});
				canOpen = Date.now() + 3e3;
				shell.openExternal(link);
			}
			else return new Response(null, {status: 404});
			return new Response(null);
		}
	},
	registerRequestHandler: (host, handler) => {
		host = host.toLowerCase();
		if (host in global.NNM.requestHandlers)
			throw new Error(JSON.stringify(host) + ' in use');
		global.NNM.requestHandlers[host] = handler;
	}
};

function uuid() {
	const G = [];
	for (let Q = 0; Q < 36; Q++) G.push(Math.floor(Math.random() * 16));
	return G[14] = 4, G[19] = G[19] &= -5, G[19] = G[19] |= 8, G[8] = G[13] = G[18] = G[23] = "-", G.map((Q) => Q.toString(16)).join("")
}

const MSG_NOTFOUND = `Unable to find FLARE NUINUI QUEST${(platform === 'win32' ? '.exe' : '')}. Ensure that NuinuiMods is placed in your game directory` + (platform === 'win32' ? '.' : ', or pass the executable file manually using <code>--game</code>.');

if (!gameExe) {
	nnm404 = MSG_NOTFOUND;
} else if (fs.statSync(resolve(dirname(gameExe), 'resources/app.asar'), {throwIfNoEntry: false})?.isDirectory()) {
	global.NNM.baseGameRoot = resolve(dirname(gameExe), 'resources/app.asar');
	nnmReady = true;
} else if (gameExe.toLowerCase().endsWith('.asar') && fs.statSync(gameExe, {throwIfNoEntry: false})?.isDirectory()) {
	global.NNM.baseGameRoot = gameExe;
	nnmReady = true;
} else if (fs.statSync(gameExe, {throwIfNoEntry: false})?.isFile() && platform === 'win32') {
	let bin = fs.readFileSync(gameExe);
	const code = uuid();
	const cachePath = resolve(app.getPath('userData'), createHash('sha256').update(bin).digest('hex') + '.asar');
	if (fs.existsSync(cachePath)) {
		global.NNM.baseGameRoot = cachePath;
		nnmReady = true;
		bin = null;
	} else {
		Promise.all([import('ws'), import('@electron/asar')]).then(([ws, asar]) => {
			let server = new ws.WebSocketServer({port: 0, host: 'localhost'}), timeout = setTimeout(() => nnm404 || (nnm404 = 'There was an error during asset extraction.'), 5e4), process, path, files = [];
			server.on('connection', ws => {
				let trusted;
				ws.on('message', (data, isBinary) => {
					const msg = isBinary ? data : data.toString();
					if (!trusted) {
						if (msg === code) {
							clearTimeout(timeout);
							trusted = true;
						}
						return;
					}
					if (msg === '$') {
						asar.createPackageFromStreams(cachePath, files).then(() => {
							global.NNM.baseGameRoot = cachePath;
							nnmReady = !nnm404;
							process.kill();
							server.close();
						});
					} else if (isBinary) {
						files.push({
							type: 'file',
							path,
							unpacked: false,
							stat: {size: msg.length, mode: 33188},
							streamGenerator: () => Readable.from([msg])
						});
						ws.send('>');
					} else path = msg;
				});
				ws.on('close', () => nnmReady || exit());
			});
			server.on('listening', _ => {
				let index = bin.indexOf('var __TAURI_IIFE__');
				if (index < 0) index = bin.indexOf('(function () {\n  function uid()');
				if (index < 0) nnm404 = 'Error: supplied game is not a known version of FLARE NUINUI QUEST.<p>If you have found an obscure/old version of the game and want NuinuiMods to add support for it, please open an issue on <a href="#" style="color:#66f" onclick="fetch(\'/open?link=https%3A%2F%2Fgithub.com%2FStellatedCUBE%2FNuinuiMods%2Fissues%2F\')">the Github repository</a>.';
				else {
					Buffer.from(`
var E,S=1,A,
O='Extracting game data<br>Please wait',
W=new WebSocket('ws://localhost:${server.address().port}/'),
L=['index.html'],
I=[],
$=v=>Promise.resolve(v),
G=u=>fetch(u).then(r=>r.text()),
F=async function(){
W.send("${code}");
document.fonts.add=_=>0;
L.push(...(await G(L[0])).split('\\n').filter(l=>/\\s(src|href)="/.test(l)).map(l=>{
let s=l.split('"');
return s[1+s.indexOf(s.find(s=>/\\s(src|href)=$/.test(s)))]
}).filter(u=>!u.includes('//')));
for(let i of L)
if(i.endsWith('.js')){
let t=await G(i);
L.push(...t.matchAll(/['"][^'"\\\\]*\\.(gif|png)['"]/gi).map(m=>eval(m[0])));
L.push(...t.matchAll(/fetch\\s*\\(\\s*['"][^'"\\\\]*['"]\\s*\\)/g).map(m=>eval(m[0].substr(5))));
if(i.endsWith('/assets.js'))A=t;
}
A=new Function('fetch','Image','FontFace',A+'\\nreturn new Assets');
A=A(
u=>$({text:_=>$({match:_=>[]}),json:_=>$({}),arrayBuffer:$},L.push(u)),
function(){I.push(this)},
function(_,u){L.push(...(u.match(/url\\((.*)\\)/)||[]).slice(1));this.load=$}
);
A.audioCtx={decodeAudioData:(_,f)=>f()};
A.load(document.head).then(_=>S=0);
while(S){
for(let i of I)i.onload&&i.onload();
await new Promise(r=>setTimeout(r,99));
}
for(let i of [...L,...I.map(i=>i.src)]){
E=O+'<br><small style="color:#bbb">Extracting '+i;
S=new Promise(r=>W.onmessage=r);
W.send(i);
W.send(await(await fetch(i)).arrayBuffer());
await S;
}
W.send('$');
E=O+'<br><small style="color:#bbb">Packing...';
};
W.onopen=_=>F().catch(e=>E='An error occurred:<br>'+e);
E=O;
setInterval(_=>document.body.innerHTML='<p style="text-align:center;color:#fff;width:100vw;margin-top:20vh;font-family:sans-serif;">'+E,32);
//`.replace(/[\r\n]/g,'')).copy(bin, index);
					while (bin[index]) {
						if (bin[index] === 10 || bin[index] === 13) {
							if (bin[index+1] === 47 && bin[index+2] === 47)
								break;
							bin[index] = 32;
						}
						index++;
					}
					extractorDir = resolve(app.getPath('temp'), uuid());
					fs.mkdirSync(extractorDir);
					const extractorPath = resolve(extractorDir, 'fnnq.exe');
					fs.writeFileSync(extractorPath, bin);
					bin = null;
					fs.writeFileSync(resolve(extractorDir, 'steam_appid.txt'), '3081830');
					fs.writeFileSync(resolve(extractorDir, 'steam_api64.dll'), fs.readFileSync(resolve(import.meta.dirname, 'patch.dat')));
					process = spawn(extractorPath, []);
				}
			});
		}).catch(e=>nnm404=gameExe=''+e);
	}
} else nnm404 = MSG_NOTFOUND;

function walk(pf) {
	for (const e of fs.readdirSync(resolve(global.NNM.modDirectory, pf), {withFileTypes: true})) {
		if (e.isDirectory() || e.name.toLowerCase().endsWith('.asar'))
			walk(`${pf}/${e.name}`);
		else if (!e.isSymbolicLink())
			modFiles.push(`${pf}/${e.name}`);
	}
}

const signingKey = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5VvzvMVdleuwOSG6Eo+E1BhQH29fTu4Prm+qTLNYNa0=
-----END PUBLIC KEY-----`);

app.whenReady().then(async () => {
	protocol.handle('nnm', request => {
		const url = new URL(request.url);
		const handler = global.NNM.requestHandlers[url.host.toLowerCase()];
		return handler ? handler(request, url) : new Response(null, {status: 404});
	});

	while (!nnmReady && !nnm404) await new Promise(done => setTimeout(done, 128));

	if (extractorDir) fs.rm(extractorDir, {force: true, recursive: true, maxRetries: 20}, () => {});

	if (!nnm404) {
		try { fs.mkdirSync(global.NNM.modDirectory); }
		catch {}

		for (const mod of fs.readdirSync(global.NNM.modDirectory)) {
			if (mods.length && !mods.includes(mod)) continue;

			try { walk(mod + '/asset'); }
			catch {}

			try {
				const path = resolve(global.NNM.modDirectory, mod, 'privileged.js');
				const pjs = fs.readFileSync(path);
				privileged.push(mod);
				if (trustAll || trusted.includes(mod)) continue;
				const hash = createHash('sha256').update(pjs).digest('hex');
				newHashes[mod] = hash;
				if (hashes.includes(hash)) continue;
				untrusted.push(mod);
				const sig = fs.readFileSync(path + '.sig');
				if (!verify(null, pjs, signingKey, sig))
					privileged.pop();
				untrusted.pop();
			}
			catch {}
		}
	}

	NNM.window = new BrowserWindow({
		width: 960,
		height: 576,
		icon: 'icon.png',
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
		}
	});

	if (noMenu) NNM.window.setMenu(null);
	if (inspector) NNM.window.webContents.openDevTools();
	NNM.window.setTitle('FLARE NUINUI QUEST');
	NNM.window.loadURL(nnm404 ? 'nnm://nnm/404' : untrusted.length ? 'nnm://nnm/untrusted' : 'nnm://nnm/');
});

app.on('window-all-closed', app.quit.bind(app));
