// Archivo (variable width, wide for display) for everything; IBM Plex Mono only for hashes.
import { Archivo, IBM_Plex_Mono } from "next/font/google";

export const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo" });
export const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono" });
