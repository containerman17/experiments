import { type ReactNode } from "react";

interface ExampleCardProps {
    children: ReactNode;
    curlString: string;
    name: string;
}

export default function ExampleCard({ children, curlString, name }: ExampleCardProps) {
    return (
        <div className="border border-gray-200 rounded-xl bg-white overflow-hidden">
            {/* Header */}
            <div className="border-b border-gray-200 px-6 py-4 bg-gray-50">
                <h3 className="text-sm font-semibold">{name}</h3>
            </div>

            {/* Content */}
            <div className="p-6">
                {children}
            </div>

            {/* CURL Example */}
            <div className="border-t border-gray-200 px-6 py-4 bg-gray-50">
                <div className="text-xs font-medium uppercase tracking-wide mb-2">Curl Example</div>
                <pre className="text-xs font-mono w-full block overflow-x-auto m-0 p-0 bg-transparent border-0 rounded-none text-gray-800">{curlString}</pre>
            </div>
        </div>
    );
}
