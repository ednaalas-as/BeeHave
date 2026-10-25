import logo from "../../../../packages/shared/assets/beehave-logo.png";
import { Wordmark } from "./Wordmark";

export function Logo() {
  return (
    <div className="logo">
      <img className="logo-image" src={logo} alt="" width={48} height={48} />
      <span>
        <Wordmark />
        <small>BEE ACTIVITY MONITORING</small>
      </span>
    </div>
  );
}
