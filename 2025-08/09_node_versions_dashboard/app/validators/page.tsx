export default function ValidatorsPage() {
    return (
        <div className="py-8">
            <h1 className="text-3xl font-bold mb-6">Validators</h1>
            <p className="text-muted-foreground mb-8">
                Manage and monitor Avalanche validators across different networks.
            </p>

            <div className="grid gap-6 md:grid-cols-2">
                <div className="border border-border rounded-lg p-6">
                    <h2 className="text-xl font-semibold mb-3">Validator Versions</h2>
                    <p className="text-sm text-muted-foreground mb-4">
                        View different validator versions and their specifications.
                    </p>
                    <a
                        href="/validators/versions"
                        className="inline-flex items-center text-sm font-medium text-primary hover:underline"
                    >
                        View Versions →
                    </a>
                </div>

                <div className="border border-border rounded-lg p-6">
                    <h2 className="text-xl font-semibold mb-3">Validator APIs</h2>
                    <p className="text-sm text-muted-foreground mb-4">
                        Access validator API endpoints and documentation.
                    </p>
                    <span className="inline-flex items-center text-sm text-muted-foreground">
                        Coming soon...
                    </span>
                </div>
            </div>
        </div>
    )
}
