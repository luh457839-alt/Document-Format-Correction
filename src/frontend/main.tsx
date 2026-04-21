import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// 必须在此处引入全局样式文件以激活 Tailwind CSS
import './index.css'; 

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);