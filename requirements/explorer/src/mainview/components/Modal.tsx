import type { ReactNode } from "react";

interface ModalProps {
	title: string;
	onClose: () => void;
	children: ReactNode;
	footer?: ReactNode;
	className?: string;
}

export default function Modal({ title, onClose, children, footer, className }: ModalProps) {
	return (
		<div className="modal-overlay" onMouseDown={onClose}>
			<div
				className={`modal${className ? ` ${className}` : ""}`}
				onMouseDown={(e) => e.stopPropagation()}
			>
				<header>
					<span>{title}</span>
					<button className="close" onClick={onClose} aria-label="close">
						×
					</button>
				</header>
				<div className="body">{children}</div>
				{footer && <footer>{footer}</footer>}
			</div>
		</div>
	);
}