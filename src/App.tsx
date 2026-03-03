import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import Home from './pages/Home';
import StrategyDashboard from './pages/StrategyDashboard';
import XSolMetrics from './pages/XSolMetrics';
import CRAlerts from './pages/CRAlerts';
import './App.css';

function App() {
  return (
    <>
      <Navbar />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/dashboard" element={<StrategyDashboard />} />
        <Route path="/xsol-metrics" element={<XSolMetrics />} />
        <Route path="/cr-alerts" element={<CRAlerts />} />
      </Routes>
    </>
  );
}

export default App;
