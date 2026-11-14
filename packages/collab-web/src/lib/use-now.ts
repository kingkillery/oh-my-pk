import { useEffect, useState } from "react";

/** Current epoch ms, re-rendered once a second while `ticking` is true. */
export function useNow(ticking: boolean): number {
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!ticking) return;
		const id = window.setInterval(() => setTick(count => count + 1), 1000);
		return () => window.clearInterval(id);
	}, [ticking]);
	return Date.now();
}
