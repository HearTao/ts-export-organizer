import { a, b as bb, c, T } from './libs';
import { baz } from './libs/baz';
import { ext } from 'ext_modules';
import * as ns from './libs';

declare const t: T;
declare const ttt: ns.TTT;
console.log(a, bb, c, ext, baz, ns.dd);
