import { spawnSync } from 'child_process';
import { chromaDist } from '../docs/core.js';
const [vid, f] = process.argv.slice(2);
const AW = 1271, AH = 720;
const b = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', vid, '-vf', `select=eq(n\\,${f}),scale=${AW}:${AH}`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 2 ** 31 }).stdout;
let s = [0, 0, 0], n = 0;
for (let i = 0; i < AW * AH; i++) { s[0] += b[4 * i]; s[1] += b[4 * i + 1]; s[2] += b[4 * i + 2]; n++; }
const m = s.map((v) => v / n);
console.log('frame mean', m.map(Math.round));
for (const [nm, c] of [['ball', [172, 130, 90]], ['ball2', [171, 137, 101]], ['skin', [220, 153, 87]], ['skin2', [211, 146, 86]], ['club?', [140, 84, 50]]]) console.log(nm, chromaDist(c, m).toFixed(3));
