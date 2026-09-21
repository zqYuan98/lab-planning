import LabMark from './LabMark'

export default function WorkspaceBrand({ wordmark = false }: { wordmark?: boolean }) {
  if (wordmark) return (
    <div className="brand-wordmark">
      <LabMark />
      <div className="brand-wordmark-copy"><strong>天枢实验室</strong><span>TIANSHU LAB</span></div>
    </div>
  )
  return (
    <div className="brand">
      <span className="brand-icon"><LabMark /></span>
      <span className="brand-name">天枢实验室<small>部门工作空间</small></span>
    </div>
  )
}
