import { createRouter, createWebHistory } from 'vue-router';
import { hasApiKey, setUnauthorizedHandler } from './api/client';
import LoginView from './views/LoginView.vue';
import OverviewView from './views/OverviewView.vue';
import ProvidersView from './views/ProvidersView.vue';
import ModelsView from './views/ModelsView.vue';
import ClientsView from './views/ClientsView.vue';
import AliasesView from './views/AliasesView.vue';
import LogsView from './views/LogsView.vue';

/**
 * The app is mounted under the Vite `base` (`/dashboard/`), so the router base
 * must match. `import.meta.env.BASE_URL` is that same value.
 */
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: { name: 'overview' } },
    {
      path: '/login',
      name: 'login',
      component: LoginView,
      meta: { public: true, title: 'Sign in' },
    },
    {
      path: '/overview',
      name: 'overview',
      component: OverviewView,
      meta: { title: 'Overview' },
    },
    {
      path: '/providers',
      name: 'providers',
      component: ProvidersView,
      meta: { title: 'Providers' },
    },
    {
      path: '/models',
      name: 'models',
      component: ModelsView,
      meta: { title: 'Model catalog' },
    },
    {
      path: '/clients',
      name: 'clients',
      component: ClientsView,
      meta: { title: 'Clients' },
    },
    {
      path: '/aliases',
      name: 'aliases',
      component: AliasesView,
      meta: { title: 'Aliases' },
    },
    {
      path: '/logs',
      name: 'logs',
      component: LogsView,
      meta: { title: 'Logs' },
    },
    { path: '/:pathMatch(.*)*', redirect: { name: 'overview' } },
  ],
});

// A rejected key (HTTP 401) clears localStorage in the client and asks the
// router to land the operator on the login view.
setUnauthorizedHandler(() => {
  void router.replace({ name: 'login' });
});

// Route guard: everything except the login view requires a stored API key.
router.beforeEach((to) => {
  if (!to.meta.public && !hasApiKey()) {
    return { name: 'login' };
  }
  if (to.name === 'login' && hasApiKey()) {
    return { name: 'overview' };
  }
  return true;
});
