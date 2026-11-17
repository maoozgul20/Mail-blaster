import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { useAuth } from './lib/auth';
import { Skeleton } from './components/ui';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Campaigns from './pages/Campaigns';
import CampaignDetail from './pages/CampaignDetail';
import NewCampaign from './pages/NewCampaign';
import Contacts from './pages/Contacts';
import Templates from './pages/Templates';
import FollowUps from './pages/FollowUps';
import Activity from './pages/Activity';
import Suppression from './pages/Suppression';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';
import AccountIntegrations from './pages/AccountIntegrations';

function Protected({ children }: { children: JSX.Element }) {
  const { session, loading } = useAuth();
  if (!session) return <Navigate to="/login" replace />;
  if (loading) return <div className="mx-auto max-w-3xl space-y-4 p-10"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-64" /></div>;
  return children;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Protected><Layout /></Protected>}>
        <Route index element={<Overview />} />
        <Route path="campaigns" element={<Campaigns />} />
        <Route path="campaigns/new" element={<NewCampaign />} />
        <Route path="campaigns/:id/edit" element={<NewCampaign />} />
        <Route path="campaigns/:id" element={<CampaignDetail />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="templates" element={<Templates />} />
        <Route path="follow-ups" element={<FollowUps />} />
        <Route path="activity" element={<Activity />} />
        <Route path="suppression" element={<Suppression />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="settings" element={<Settings />} />
        <Route path="settings/account" element={<AccountIntegrations />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
