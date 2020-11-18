/// <reference path="../src/ts.d.ts"/>
import * as path from 'path';
import { fixFromProject } from '../src';

fixFromProject(path.resolve(__dirname, 'project'), undefined, undefined, file =>
    file.fileName.includes('libs')
);
