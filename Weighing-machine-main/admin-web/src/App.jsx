import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { isLoggedIn } from './api/client.js';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Reports from './pages/Reports.jsx';
import ReportEdit from './pages/ReportEdit.jsx';
import AdvanceSettings from './pages/AdvanceSettings.jsx';
import SyncStatus from './pages/SyncStatus.jsx';
import RemoteTrips from './pages/RemoteTrips.jsx';

function PrivateRoute({ children }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <PrivateRoute>
              <Layout />
            </PrivateRoute>
          }
        >
          <Route index element={<Navigate to="/reports" replace />} />
          <Route path="reports" element={<Reports />} />
          <Route path="reports/:slip/edit" element={<ReportEdit />} />
          <Route path="remote-trips" element={<RemoteTrips />} />
          <Route path="settings/advance" element={<AdvanceSettings />} />
          <Route path="sync" element={<SyncStatus />} />
        </Route>
        <Route path="*" element={<Navigate to="/reports" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
