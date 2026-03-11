import { defineConfig } from '@umijs/max';

export default defineConfig({
  antd: {},
  access: {},
  model: {},
  initialState: {},
  request: {},
  layout: {
    title: 'AI Video Agent',
  },
  routes: [
    {
      path: '/',
      redirect: '/workflow',
    },
    {
      name: '工作流演示',
      path: '/workflow',
      component: './Workflow',
    },
  ],
  npmClient: 'pnpm',
});

