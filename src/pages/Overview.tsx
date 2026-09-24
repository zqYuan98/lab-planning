import MyActions from '../components/MyActions';
import type { Navigate } from "../navigation";
import type { PageProps } from "../ui";
import PersonalOverview from "./PersonalOverview";
import DepartmentOverview from "./DepartmentOverview";

export default function Overview(props: PageProps & { navigate: Navigate }) {
  return <><MyActions {...props}/>{props.data.user.role === "manager" ? (
    <DepartmentOverview {...props} />
  ) : (
    <PersonalOverview {...props} />
  )}</>;
}
