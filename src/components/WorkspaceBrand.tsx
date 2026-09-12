import labIcon from '../assets/lab-icon.png'
import labWordmark from '../assets/lab-wordmark.png'

export default function WorkspaceBrand({ wordmark = false }: { wordmark?: boolean }) {
  if (wordmark) return (
    <div className="brand-wordmark">
      <img src={labWordmark} alt="天枢实验室 TIANSHU LAB" />
      <span>部门工作空间</span>
    </div>
  )
  return (
    <div className="brand">
      <span className="brand-icon"><img src={labIcon} alt="" /></span>
      <span className="brand-name">天枢实验室<small>部门工作空间</small></span>
    </div>
  )
}
