import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { SessionDetail } from './pages/SessionDetail';
import { SessionInteract } from './pages/SessionInteract';
import { WorkflowOverview } from './pages/WorkflowOverview';
import { DockerManagement } from './pages/DockerManagement';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/session/:id" element={<SessionDetail />} />
        <Route path="/session/:id/interact" element={<SessionInteract />} />
        <Route path="/workflow" element={<WorkflowOverview />} />
        <Route path="/docker" element={<DockerManagement />} />
      </Routes>
    </BrowserRouter>
  );
}
