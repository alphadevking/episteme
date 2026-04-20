import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  width?: number;
  height?: number;
  asLink?: boolean;
}

export function Logo({ 
  className, 
  width = 40, 
  height = 40, 
  asLink = true 
}: LogoProps) {
  const LogoImage = (
    <Image 
      src="/episteme.png" 
      alt="Episteme Logo" 
      width={width} 
      height={height} 
      className={cn("object-contain", className)}
      priority
    />
  );

  if (asLink) {
    return (
      <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-90">
        {LogoImage}
      </Link>
    );
  }

  return LogoImage;
}
