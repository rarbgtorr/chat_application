import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.PORT || 3000);
app.server.listen(port, '0.0.0.0', () => console.log(`Wingfactor Support listening on port ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await app.close();
  process.exit(0);
});
