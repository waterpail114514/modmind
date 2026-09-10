const { app } = require('electron');
const path = require('node:path');
if (!process.env.MODMIND_TEST_USER_DATA) throw new Error('Isolated user data is required');
app.setPath('userData', process.env.MODMIND_TEST_USER_DATA);
app.setPath('logs', path.join(process.env.MODMIND_TEST_USER_DATA, 'logs'));
const repository = path.resolve(__dirname, '..');
app.getAppPath = () => repository;
require(path.join(repository, 'out/main/index.js'));
