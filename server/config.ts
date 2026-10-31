import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'starter_pack', 'CrunchWeek_StarterPack', 'data');
export const EXPORTS_DIR = path.join(ROOT_DIR, 'exports');
export const STORAGE_DIR = path.join(ROOT_DIR, 'data', 'storage');

export const DATASET_PATH = path.join(DATA_DIR, 'cit_public.json');
export const DISRUPTION_PATH = path.join(ROOT_DIR, 'starter_pack', 'CrunchWeek_StarterPack', 'examples', 'sample_disruption.json');
export const VALIDATOR_PATH = path.join(ROOT_DIR, 'starter_pack', 'CrunchWeek_StarterPack', 'validator.py');
export const SOLVER_PATH = path.join(ROOT_DIR, 'solver.py');

export const PYTHON_EXEC = process.env.PYTHON_EXEC || '/usr/bin/python3';
export const PORT = parseInt(process.env.PORT || '3000', 10);
export const HOST = process.env.HOST || '0.0.0.0';
