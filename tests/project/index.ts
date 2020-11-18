import { a, b as bb, c, T } from './libs';
import { baz } from './libs/baz';
import { ext } from 'ext_modules';

declare const t: T;
console.log(a, bb, c, ext, baz);
