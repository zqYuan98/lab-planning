export function deliveryTiming(submittedAt:string,dueDate:string,accepted:boolean):string {
  if(!dueDate)return accepted?'成果已通过；提交时未设截止日期，无法判断是否按时达标。':'已提交；提交时未设截止日期，质量待确认。'
  const date=new Date(new Date(submittedAt).getTime()+8*3600000).toISOString().slice(0,10)
  const onTime=date<=dueDate
  return `${onTime?'本版本按时提交':'本版本晚于提交时的截止日期'}；${accepted?onTime?'成果通过，按时达标交付':'成果通过，逾期达标交付':'质量待确认'}。依据：${dueDate}。`
}
