import React from 'react'
import ReactDOM from 'react-dom/client'
import ConfigProvider from '@arco-design/web-react/es/ConfigProvider'
import zhCN from '@arco-design/web-react/es/locale/zh-CN'
import './arco-styles'
import App from './App'
import './styles.css'
import './theme.css'
import './workspace-shell.css'
import './workspace-tech.css'
import './auth-tech.css'
import './workspace-saas.css'
import './components/CarryWorkflowWizard.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
)
import './weekly-submissions.css'
