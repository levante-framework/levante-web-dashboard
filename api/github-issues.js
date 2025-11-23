/**
 * API endpoint to fetch GitHub project issues using GraphQL API
 * Returns issues from the levante-framework project board
 */

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        // GitHub API configuration
        const GITHUB_API_BASE = 'https://api.github.com';
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
        
        console.log('GitHub token available:', !!GITHUB_TOKEN);
        
        // Headers for GitHub GraphQL API
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Levante-Dashboard/1.0'
        };
        
        // Add token if available
        if (GITHUB_TOKEN) {
            headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
            console.log('Using GitHub token for authentication');
        } else {
            console.log('No GitHub token found');
            return res.status(200).json({
                total: 0,
                open: 0,
                closed: 0,
                issues: [],
                source: 'none',
                message: 'GitHub Projects API requires authentication. Please add a GITHUB_TOKEN environment variable.'
            });
        }

        // Use GraphQL API to fetch project items with custom fields
        const graphqlQuery = {
            query: `
                query {
                    organization(login: "levante-framework") {
                        projectV2(number: 1) {
                            title
                            url
                            fields(first: 20) {
                                nodes {
                                    ... on ProjectV2Field {
                                        id
                                        name
                                        dataType
                                    }
                                    ... on ProjectV2SingleSelectField {
                                        id
                                        name
                                        dataType
                                        options {
                                            id
                                            name
                                        }
                                    }
                                }
                            }
                            items(first: 100) {
                                nodes {
                                    id
                                    fieldValues(first: 20) {
                                        nodes {
                                            ... on ProjectV2ItemFieldSingleSelectValue {
                                                field {
                                                    ... on ProjectV2SingleSelectField {
                                                        id
                                                        name
                                                        dataType
                                                    }
                                                }
                                                name
                                            }
                                        }
                                    }
                                    content {
                                        __typename
                                        ... on Issue {
                                            number
                                            title
                                            state
                                            url
                                            createdAt
                                            updatedAt
                                            assignees(first: 10) {
                                                nodes {
                                                    login
                                                }
                                            }
                                            labels(first: 20) {
                                                nodes {
                                                    name
                                                }
                                            }
                                        }
                                        ... on PullRequest {
                                            number
                                            title
                                            state
                                            url
                                            createdAt
                                            updatedAt
                                            assignees(first: 10) {
                                                nodes {
                                                    login
                                                }
                                            }
                                            labels(first: 20) {
                                                nodes {
                                                    name
                                                }
                                            }
                                        }
                                    }
                                }
                                pageInfo {
                                    endCursor
                                    hasNextPage
                                }
                            }
                        }
                    }
                }
            `
        };

        console.log('Making GraphQL request to GitHub API...');
        const graphqlResponse = await fetch(`${GITHUB_API_BASE}/graphql`, {
            method: 'POST',
            headers,
            body: JSON.stringify(graphqlQuery)
        });

        if (!graphqlResponse.ok) {
            console.error('GraphQL API error:', graphqlResponse.status, graphqlResponse.statusText);
            const errorText = await graphqlResponse.text();
            console.error('GraphQL error response:', errorText);
            
            // Fallback to repository issues with higher limit
            const issuesResponse = await fetch(`${GITHUB_API_BASE}/repos/levante-framework/levante-dashboard/issues?state=all&per_page=100`, {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'User-Agent': 'Levante-Dashboard/1.0'
                }
            });
            
            if (issuesResponse.ok) {
                const issues = await issuesResponse.json();
                let totalIssues = 0;
                let openIssues = 0;
                let closedIssues = 0;
                const issueDetails = [];
                
                for (const issue of issues) {
                    totalIssues++;
                    issueDetails.push({
                        number: issue.number,
                        title: issue.title,
                        state: issue.state,
                        column: 'Repository Issues',
                        url: issue.html_url,
                        created_at: issue.created_at,
                        updated_at: issue.updated_at,
                        assignee: issue.assignee ? issue.assignee.login : null,
                        labels: issue.labels.map(label => label.name)
                    });
                    
                    if (issue.state === 'open') {
                        openIssues++;
                    } else {
                        closedIssues++;
                    }
                }
                
                return res.status(200).json({
                    total: totalIssues,
                    open: openIssues,
                    closed: closedIssues,
                    issues: issueDetails,
                    source: 'repository',
                    project: {
                        name: 'levante-dashboard Repository',
                        url: 'https://github.com/levante-framework/levante-dashboard'
                    }
                });
            }
            
            return res.status(200).json({
                total: 0,
                open: 0,
                closed: 0,
                issues: [],
                source: 'none',
                message: 'Project not found or not accessible. Check if the project exists at https://github.com/orgs/levante-framework/projects/1'
            });
        }

        const graphqlData = await graphqlResponse.json();
        
        if (graphqlData.errors) {
            console.error('GraphQL errors:', graphqlData.errors);
            return res.status(200).json({
                total: 0,
                open: 0,
                closed: 0,
                issues: [],
                source: 'none',
                message: `GraphQL API error: ${graphqlData.errors[0].message}`
            });
        }

        const project = graphqlData.data?.organization?.projectV2;
        
        if (!project) {
            return res.status(200).json({
                total: 0,
                open: 0,
                closed: 0,
                issues: [],
                source: 'none',
                message: 'Project not found. Check if the project exists at https://github.com/orgs/levante-framework/projects/1'
            });
        }

        let totalIssues = 0;
        let openIssues = 0;
        let closedIssues = 0;
        const issueDetails = [];

        // Track breakdowns by Priority and Status
        const priorityBreakdown = {};
        const statusBreakdown = {};

        console.log(`Found ${project.items.nodes.length} items in project`);

        // Process all items from the project
        for (const item of project.items.nodes) {
            if (item.content) {
                const content = item.content;
                totalIssues++;
                
                // Extract Priority and Status from field values
                let priority = 'No Priority';
                let status = 'No Status';
                
                for (const fieldValue of item.fieldValues.nodes) {
                    if (fieldValue.field && fieldValue.name) {
                        const fieldName = fieldValue.field.name.toLowerCase();
                        if (fieldName.includes('priority')) {
                            priority = fieldValue.name;
                        } else if (fieldName.includes('status')) {
                            status = fieldValue.name;
                        }
                    }
                }
                
                const issueData = {
                    number: content.number,
                    title: content.title,
                    state: content.state,
                    column: 'Project Board',
                    url: content.url,
                    created_at: content.createdAt,
                    updated_at: content.updatedAt,
                    assignee: content.assignees?.nodes?.[0]?.login || null,
                    labels: content.labels?.nodes?.map(label => label.name) || [],
                    priority: priority,
                    status: status
                };
                
                issueDetails.push(issueData);
                
                // Count by state
                if (content.state === 'OPEN') {
                    openIssues++;
                } else {
                    closedIssues++;
                }
                
                // Count by priority
                if (!priorityBreakdown[priority]) {
                    priorityBreakdown[priority] = { total: 0, open: 0, closed: 0 };
                }
                priorityBreakdown[priority].total++;
                if (content.state === 'OPEN') {
                    priorityBreakdown[priority].open++;
                } else {
                    priorityBreakdown[priority].closed++;
                }
                
                // Count by status
                if (!statusBreakdown[status]) {
                    statusBreakdown[status] = { total: 0, open: 0, closed: 0 };
                }
                statusBreakdown[status].total++;
                if (content.state === 'OPEN') {
                    statusBreakdown[status].open++;
                } else {
                    statusBreakdown[status].closed++;
                }
            }
        }

        console.log(`Processed ${totalIssues} issues: ${openIssues} open, ${closedIssues} closed`);
        console.log('Priority breakdown:', priorityBreakdown);
        console.log('Status breakdown:', statusBreakdown);

        // Filter for open P0 and P1 issues
        const p0OpenIssues = issueDetails.filter(issue => 
            issue.state === 'OPEN' && issue.priority === 'P0'
        );
        const p1OpenIssues = issueDetails.filter(issue => 
            issue.state === 'OPEN' && issue.priority === 'P1'
        );

        // Count P0 and P1 open issues for statistics
        const p0OpenCount = p0OpenIssues.length;
        const p1OpenCount = p1OpenIssues.length;
        const totalHighPriority = p0OpenCount + p1OpenCount;

        // Return the data with P0 and P1 focus
        res.status(200).json({
            total: totalHighPriority,
            open: totalHighPriority,
            closed: 0,
            issues: [...p0OpenIssues, ...p1OpenIssues], // Return both P0 and P1 open issues
            p0OpenIssues: p0OpenIssues,
            p1OpenIssues: p1OpenIssues,
            source: 'project',
            project: {
                name: project.title,
                url: project.url
            },
            breakdowns: {
                priority: { 
                    'P0': { total: p0OpenCount, open: p0OpenCount, closed: 0 },
                    'P1': { total: p1OpenCount, open: p1OpenCount, closed: 0 }
                },
                status: statusBreakdown
            }
        });

    } catch (error) {
        console.error('GitHub issues API error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch GitHub issues',
            details: error.message 
        });
    }
}