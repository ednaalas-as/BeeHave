import { Image } from "react-native";
import logo from "../../../../packages/shared/assets/beehave-logo.png";

export function BrandLogo({ size = 48 }: { size?: number }) {
  return (
    <Image
      source={logo}
      accessibilityLabel="BeeHave logo"
      style={{ width: size, height: size }}
      resizeMode="contain"
    />
  );
}
