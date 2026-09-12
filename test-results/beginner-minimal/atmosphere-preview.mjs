import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
const server = await createServer({configFile:false,root:process.cwd(),plugins:[react()],server:{host:'127.0.0.1',port:5208}});
await server.listen();
const browser=await chromium.launch({headless:true});
try {
const page=await browser.newPage({viewport:{width:1440,height:900}});
await page.goto(server.resolvedUrls.local[0]+'test-results/beginner-minimal/react.html');
await page.locator('.workbench-welcome-emblem').waitFor();
await page.locator('.app-shell').evaluate(el=>el.classList.add('dark-mode'));
await page.screenshot({path:'test-results/beginner-minimal/atmosphere-dark.png'});
await page.getByLabel('专业模式',{exact:true}).check();
await page.screenshot({path:'test-results/beginner-minimal/atmosphere-workbench.png'});
console.log('Captured dark beginner and full workbench previews.');
} finally {await browser.close();await server.close();}
