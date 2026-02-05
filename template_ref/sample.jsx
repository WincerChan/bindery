import React, { useState, useEffect } from 'react';
import {
    Library,
    Upload,
    Activity,
    Settings,
    LogOut,
    Search,
    LayoutGrid,
    List as ListIcon,
    MoreVertical,
    Edit3,
    Download,
    RefreshCw,
    Trash2,
    FileText,
    CheckCircle2,
    AlertCircle,
    Clock,
    X,
    ChevronRight,
    Save,
    Eye,
    FolderOpen,
    Play
} from 'lucide-react';

/**
 * MOCK DATA
 */
const MOCK_BOOKS = [
    {
        id: 'b1',
        title: '诡秘之主',
        author: '爱潜水的乌贼',
        series: '诡秘之主系列 #1',
        cover: 'https://bookcover.longzhub.com/5df620029051867c4e03ce73/5df620029051867c4e03ce75.jpg', // Placeholder
        status: 'synced', // synced, pending, error
        path: '/library/fiction/guimi_v1.epub',
        date: '2023-10-24 14:20',
        tags: ['网文', '克苏鲁', '蒸汽朋克']
    },
    {
        id: 'b2',
        title: 'Deep Learning',
        author: 'Ian Goodfellow',
        series: 'MIT Press',
        cover: null, // No cover
        status: 'pending',
        path: '/library/tech/deep_learning.epub',
        date: '2023-10-25 09:15',
        tags: ['技术', 'AI']
    },
    {
        id: 'b3',
        title: '三体全集',
        author: '刘慈欣',
        series: '',
        cover: 'https://img1.doubanio.com/view/subject/l/public/s2768378.jpg',
        status: 'error',
        path: '/library/scifi/three_body_problem.epub',
        date: '2023-10-22 18:30',
        tags: ['科幻', '雨果奖']
    }
];

const MOCK_JOBS = [
    {
        id: 'j1',
        name: 'Processing: 诡秘_校对版.txt',
        status: 'active', // active, success, failed
        stage: 'Generating EPUB', // Pre-process, Generating, Metadata, Finalizing
        progress: 65,
        timestamp: 'Just now'
    },
    {
        id: 'j2',
        name: 'Batch: 鲁迅全集 (20 files)',
        status: 'success',
        stage: 'Completed',
        progress: 100,
        timestamp: '2 hours ago'
    },
    {
        id: 'j3',
        name: 'Import: broken_encoding.txt',
        status: 'failed',
        stage: 'Pre-process',
        error: 'Encoding Error: GBK sequence invalid at line 4021',
        progress: 10,
        timestamp: 'Yesterday'
    }
];

const MOCK_RULES = [
    { id: 'r1', name: '通用网文 (General Web Novel)', description: '识别 "第X章"、"卷X" 等标准格式' },
    { id: 'r2', name: '出版物 (Standard Publishing)', description: '基于层级标题识别，更严格的去噪' },
    { id: 'r3', name: '英文技术文档 (Tech Docs)', description: 'Markdown 风格标题 (#, ##) 提取' },
];

/**
 * SHARED COMPONENTS
 */

const BookOpenIcon = ({ className, size }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 24}
        height={size || 24}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
    >
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
    </svg>
);

/**
 * PAGE COMPONENTS
 */

// 1. Sidebar
const Sidebar = ({ activeTab, onTabChange, onLogout }) => {
    const menuItems = [
        { id: 'library', icon: Library, label: 'Library' },
        { id: 'upload', icon: Upload, label: 'Ingest' },
        { id: 'jobs', icon: Activity, label: 'Jobs' },
        { id: 'rules', icon: Settings, label: 'Rules' },
    ];

    return (
        <div className="w-64 bg-slate-900 text-slate-300 flex flex-col h-full border-r border-slate-800 shrink-0">
            <div className="p-6">
                <h1 className="text-xl font-bold text-white flex items-center gap-2">
                    <BookOpenIcon className="w-6 h-6 text-indigo-500" />
                    Bindery
                </h1>
                <p className="text-xs text-slate-500 mt-1 uppercase tracking-wider font-semibold">EPUB Factory</p>
            </div>

            <nav className="flex-1 px-3 space-y-1">
                {menuItems.map((item) => (
                    <button
                        key={item.id}
                        onClick={() => onTabChange(item.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${activeTab === item.id
                                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-900/50'
                                : 'hover:bg-slate-800 hover:text-white'
                            }`}
                    >
                        <item.icon size={18} />
                        <span className="font-medium text-sm">{item.label}</span>
                    </button>
                ))}
            </nav>

            <div className="p-4 border-t border-slate-800">
                <button onClick={onLogout} className="flex items-center gap-3 px-3 py-2 text-sm text-slate-400 hover:text-white transition-colors w-full">
                    <LogOut size={18} />
                    <span>Sign Out</span>
                </button>
            </div>
        </div>
    );
};

// 2. Auth Page
const AuthPage = ({ onLogin }) => (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden">
            <div className="p-8 text-center bg-slate-900">
                <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-indigo-900/50">
                    <BookOpenIcon className="w-8 h-8 text-white" />
                </div>
                <h2 className="text-2xl font-bold text-white">Bindery OS</h2>
                <p className="text-slate-400 mt-2">Personal eBook Foundry</p>
            </div>
            <div className="p-8">
                <label className="block text-sm font-medium text-slate-700 mb-2">Access Key</label>
                <input
                    type="password"
                    className="w-full px-4 py-3 rounded-lg border border-slate-200 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                    placeholder="••••••••"
                />
                <button
                    onClick={onLogin}
                    className="w-full mt-6 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 rounded-lg transition-colors shadow-md shadow-indigo-200"
                >
                    Enter Studio
                </button>
            </div>
        </div>
    </div>
);

// 3. Library Page
const LibraryPage = ({ onSelectBook }) => {
    const [viewMode, setViewMode] = useState('grid'); // grid | list
    const [filter, setFilter] = useState('');

    const StatusBadge = ({ status }) => {
        const config = {
            synced: { color: 'bg-green-100 text-green-700 border-green-200', text: 'Synced', icon: CheckCircle2 },
            pending: { color: 'bg-amber-100 text-amber-700 border-amber-200', text: 'Pending Write-back', icon: Clock },
            error: { color: 'bg-red-100 text-red-700 border-red-200', text: 'Conversion Error', icon: AlertCircle },
        }[status];

        const Icon = config.icon;

        return (
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${config.color}`}>
                <Icon size={12} />
                {config.text}
            </span>
        );
    };

    return (
        <div className="h-full flex flex-col bg-slate-50">
            {/* Header */}
            <header className="bg-white border-b border-slate-200 px-8 py-5 flex items-center justify-between sticky top-0 z-10">
                <div>
                    <h2 className="text-2xl font-bold text-slate-800">Library</h2>
                    <p className="text-sm text-slate-500">32 books total · 2 updated recently</p>
                </div>

                <div className="flex items-center gap-4">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                        <input
                            type="text"
                            placeholder="Filter by title, author..."
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            className="pl-10 pr-4 py-2 w-64 rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-sm"
                        />
                    </div>

                    <div className="flex bg-slate-100 p-1 rounded-lg border border-slate-200">
                        <button
                            onClick={() => setViewMode('grid')}
                            className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                            <LayoutGrid size={18} />
                        </button>
                        <button
                            onClick={() => setViewMode('list')}
                            className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                            <ListIcon size={18} />
                        </button>
                    </div>
                </div>
            </header>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-8">
                {viewMode === 'grid' ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                        {MOCK_BOOKS.map(book => (
                            <div key={book.id} className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow group overflow-hidden flex flex-col">
                                <div className="relative aspect-[2/3] bg-slate-100 border-b border-slate-100">
                                    {book.cover ? (
                                        <img src={book.cover} className="w-full h-full object-cover" alt={book.title} />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-slate-300">
                                            <BookOpenIcon size={48} />
                                        </div>
                                    )}
                                    {/* Hover Overlay */}
                                    <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-3 p-4 backdrop-blur-sm">
                                        <button onClick={() => onSelectBook(book)} className="bg-white text-slate-900 px-4 py-2 rounded-lg font-medium text-sm w-full hover:bg-indigo-50">Edit Metadata</button>
                                        <button className="bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium text-sm w-full hover:bg-indigo-700">Download EPUB</button>
                                        <div className="flex gap-2 w-full mt-2">
                                            <button className="flex-1 bg-slate-800 text-slate-200 p-2 rounded-lg hover:bg-slate-700 flex justify-center" title="Regenerate"><RefreshCw size={16} /></button>
                                            <button className="flex-1 bg-red-600/80 text-white p-2 rounded-lg hover:bg-red-600 flex justify-center" title="Delete"><Trash2 size={16} /></button>
                                        </div>
                                    </div>
                                </div>
                                <div className="p-4 flex-1 flex flex-col">
                                    <div className="mb-2">
                                        <StatusBadge status={book.status} />
                                    </div>
                                    <h3 className="font-bold text-slate-900 line-clamp-1" title={book.title}>{book.title}</h3>
                                    <p className="text-sm text-slate-500 mb-4">{book.author}</p>
                                    <div className="mt-auto pt-3 border-t border-slate-50 flex items-center justify-between text-xs text-slate-400 font-mono">
                                        <span className="truncate max-w-[120px]" title={book.path}>{book.path.split('/').pop()}</span>
                                        <span>EPUB</span>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-200">
                                <tr>
                                    <th className="px-6 py-4 w-12">Cover</th>
                                    <th className="px-6 py-4">Title / Author</th>
                                    <th className="px-6 py-4">Path / ID</th>
                                    <th className="px-6 py-4">Status</th>
                                    <th className="px-6 py-4">Date</th>
                                    <th className="px-6 py-4 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {MOCK_BOOKS.map(book => (
                                    <tr key={book.id} className="hover:bg-slate-50 group">
                                        <td className="px-6 py-3">
                                            <div className="w-8 h-12 bg-slate-200 rounded overflow-hidden">
                                                {book.cover && <img src={book.cover} className="w-full h-full object-cover" />}
                                            </div>
                                        </td>
                                        <td className="px-6 py-3">
                                            <div className="font-medium text-slate-900">{book.title}</div>
                                            <div className="text-slate-500 text-xs">{book.author}</div>
                                        </td>
                                        <td className="px-6 py-3 text-slate-400 font-mono text-xs max-w-xs truncate">
                                            {book.path}
                                        </td>
                                        <td className="px-6 py-3">
                                            <StatusBadge status={book.status} />
                                        </td>
                                        <td className="px-6 py-3 text-slate-500">
                                            {book.date}
                                        </td>
                                        <td className="px-6 py-3 text-right">
                                            <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button onClick={() => onSelectBook(book)} className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors" title="Edit">
                                                    <Edit3 size={16} />
                                                </button>
                                                <button className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors" title="Download">
                                                    <Download size={16} />
                                                </button>
                                                <button className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors" title="Regenerate">
                                                    <RefreshCw size={16} />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
};

// 4. Jobs Page
const JobsPage = ({ onGoToBook }) => {
    return (
        <div className="h-full flex flex-col bg-slate-50 p-8">
            <div className="mb-8 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-slate-800">Task Queue</h2>
                <div className="flex gap-2">
                    <span className="px-3 py-1 bg-white border border-slate-200 rounded-full text-sm font-medium text-slate-600">All: 12</span>
                    <span className="px-3 py-1 bg-indigo-50 border border-indigo-100 rounded-full text-sm font-medium text-indigo-600">Active: 1</span>
                    <span className="px-3 py-1 bg-red-50 border border-red-100 rounded-full text-sm font-medium text-red-600">Failed: 1</span>
                </div>
            </div>

            <div className="space-y-4">
                {MOCK_JOBS.map(job => (
                    <div key={job.id} className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm flex flex-col gap-4">
                        <div className="flex items-start justify-between">
                            <div className="flex items-center gap-4">
                                <div className={`p-3 rounded-full ${job.status === 'active' ? 'bg-indigo-50 text-indigo-600' :
                                        job.status === 'success' ? 'bg-green-50 text-green-600' :
                                            'bg-red-50 text-red-600'
                                    }`}>
                                    {job.status === 'active' ? <RefreshCw className="animate-spin" size={20} /> :
                                        job.status === 'success' ? <CheckCircle2 size={20} /> :
                                            <AlertCircle size={20} />}
                                </div>
                                <div>
                                    <h3 className="font-bold text-slate-900">{job.name}</h3>
                                    <div className="flex items-center gap-2 text-sm text-slate-500 mt-0.5">
                                        <span>{job.stage}</span>
                                        <span>•</span>
                                        <span>{job.timestamp}</span>
                                    </div>
                                </div>
                            </div>

                            {/* Actions */}
                            <div className="flex gap-3">
                                {job.status === 'failed' && (
                                    <button className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">View Log</button>
                                )}
                                {job.status === 'failed' ? (
                                    <button className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm shadow-indigo-200">Retry</button>
                                ) : job.status === 'success' ? (
                                    <button onClick={onGoToBook} className="px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100">Open Book</button>
                                ) : (
                                    <button className="px-4 py-2 text-sm font-medium text-red-600 bg-red-50 rounded-lg hover:bg-red-100">Cancel</button>
                                )}
                            </div>
                        </div>

                        {/* Progress or Error */}
                        <div className="pl-16">
                            {job.status === 'failed' ? (
                                <div className="bg-red-50 border border-red-100 rounded-lg p-3 text-sm text-red-800 font-mono">
                                    {job.error}
                                </div>
                            ) : (
                                <div className="w-full bg-slate-100 rounded-full h-2 mb-1">
                                    <div className={`h-2 rounded-full transition-all duration-500 ${job.status === 'success' ? 'bg-green-500' : 'bg-indigo-500'
                                        }`} style={{ width: `${job.progress}%` }}></div>
                                </div>
                            )}
                            {job.status === 'active' && <p className="text-xs text-slate-400 text-right mt-1">{job.progress}%</p>}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

// 5. Upload / Ingest Page
const UploadPage = () => {
    const [step, setStep] = useState(1); // 1: Upload, 2: Config, 3: Preview

    return (
        <div className="h-full bg-slate-50 p-8 flex flex-col">
            <div className="max-w-4xl mx-auto w-full flex-1 flex flex-col">
                <h2 className="text-2xl font-bold text-slate-800 mb-6">Ingest Text</h2>

                {/* Stepper */}
                <div className="flex items-center mb-8">
                    {[1, 2, 3].map((s) => (
                        <div key={s} className="flex items-center">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${step >= s ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-500'
                                }`}>
                                {s}
                            </div>
                            {s !== 3 && <div className={`w-24 h-1 mx-2 ${step > s ? 'bg-indigo-600' : 'bg-slate-200'}`}></div>}
                        </div>
                    ))}
                </div>

                <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex-1 p-8 flex flex-col">

                    {/* Step 1: Upload */}
                    {step === 1 && (
                        <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50 hover:bg-indigo-50/30 hover:border-indigo-300 transition-colors cursor-pointer group">
                            <div className="bg-white p-4 rounded-full shadow-sm mb-4 group-hover:scale-110 transition-transform">
                                <Upload className="text-indigo-600" size={32} />
                            </div>
                            <h3 className="text-lg font-medium text-slate-800">Drag & Drop TXT files here</h3>
                            <p className="text-slate-500 mt-2">or click to browse</p>
                            <button onClick={() => setStep(2)} className="mt-8 px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">Select Files (Demo)</button>
                        </div>
                    )}

                    {/* Step 2: Config */}
                    {step === 2 && (
                        <div className="flex-1">
                            <h3 className="text-lg font-bold text-slate-800 mb-6 border-b border-slate-100 pb-4">Metadata & Rules</h3>

                            <div className="grid grid-cols-2 gap-6">
                                <div className="space-y-4">
                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-1">Title (Auto-detected)</label>
                                        <input type="text" defaultValue="我的奋斗史" className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-1">Author</label>
                                        <input type="text" defaultValue="Unknown" className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" />
                                    </div>
                                </div>
                                <div className="space-y-4">
                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-1">Processing Rule</label>
                                        <select className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none bg-white">
                                            {MOCK_RULES.map(r => <option key={r.id}>{r.name}</option>)}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-1">Series</label>
                                        <input type="text" placeholder="Optional" className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" />
                                    </div>
                                </div>
                            </div>

                            <div className="mt-8 p-4 bg-indigo-50 rounded-lg border border-indigo-100">
                                <h4 className="text-indigo-900 font-medium text-sm flex items-center gap-2">
                                    <FolderOpen size={16} /> Target Location
                                </h4>
                                <p className="text-indigo-700 text-sm font-mono mt-1">/library/ingest/Unknown/我的奋斗史.epub</p>
                            </div>
                        </div>
                    )}

                    {/* Step 3: Preview */}
                    {step === 3 && (
                        <div className="flex-1 flex flex-col min-h-0">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="text-lg font-bold text-slate-800">Preview TOC</h3>
                                <span className="text-xs font-mono bg-slate-100 px-2 py-1 rounded text-slate-600">Rule: General Web Novel</span>
                            </div>

                            <div className="flex-1 overflow-y-auto border border-slate-200 rounded-lg bg-slate-50 p-4 font-mono text-sm">
                                <div className="text-slate-400 mb-2"># Structure detected: 1 Vol, 12 Chapters</div>
                                <div className="space-y-1">
                                    <div className="text-slate-800 font-bold">Volume 1: The Beginning</div>
                                    <div className="pl-4 text-slate-600 flex items-center gap-2"><span className="text-indigo-500 text-xs">[CH]</span> Chapter 1: Waking Up</div>
                                    <div className="pl-4 text-slate-600 flex items-center gap-2"><span className="text-indigo-500 text-xs">[CH]</span> Chapter 2: The System</div>
                                    <div className="pl-4 text-slate-600 flex items-center gap-2"><span className="text-indigo-500 text-xs">[CH]</span> Chapter 3: First Quest</div>
                                    <div className="pl-4 text-slate-600 flex items-center gap-2"><span className="text-slate-300 text-xs">[--]</span> (Skipped: Advertisement line)</div>
                                    <div className="pl-4 text-slate-600 flex items-center gap-2"><span className="text-indigo-500 text-xs">[CH]</span> Chapter 4: Loot</div>
                                    {/* More mock items */}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Footer Actions */}
                    <div className="mt-8 pt-6 border-t border-slate-100 flex justify-between">
                        {step > 1 ? (
                            <button onClick={() => setStep(step - 1)} className="px-6 py-2 text-slate-600 font-medium hover:bg-slate-50 rounded-lg">Back</button>
                        ) : <div></div>}

                        {step < 3 ? (
                            <button onClick={() => setStep(step + 1)} className="px-6 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 shadow-md shadow-indigo-200">Next</button>
                        ) : (
                            <button className="px-6 py-2 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700 shadow-md shadow-green-200 flex items-center gap-2">
                                <Play size={18} /> Start Conversion
                            </button>
                        )}
                    </div>

                </div>
            </div>
        </div>
    );
};

// 6. Book Detail Page
const BookDetailPage = ({ book, onBack }) => {
    return (
        <div className="h-full bg-slate-50 flex flex-col">
            {/* Navbar */}
            <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center gap-4 sticky top-0 z-20">
                <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-full text-slate-500">
                    <ChevronRight className="rotate-180" size={24} />
                </button>
                <h1 className="text-xl font-bold text-slate-800">{book.title}</h1>
                <div className="ml-auto flex gap-2">
                    <button className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 flex items-center gap-2">
                        <RefreshCw size={16} /> Re-Process
                    </button>
                    <button className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm flex items-center gap-2">
                        <Save size={16} /> Save Changes
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-6xl mx-auto grid grid-cols-12 gap-8">

                    {/* Left Col: Cover & Primary Info */}
                    <div className="col-span-12 lg:col-span-4 space-y-6">
                        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col items-center">
                            <div className="w-48 aspect-[2/3] bg-slate-100 rounded shadow-inner mb-6 relative group cursor-pointer overflow-hidden">
                                {book.cover ? <img src={book.cover} className="w-full h-full object-cover" /> : <div className="p-8 text-center text-slate-400">No Cover</div>}
                                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white font-medium">
                                    Change Cover
                                </div>
                            </div>
                            <div className="w-full space-y-3">
                                <button className="w-full py-2.5 bg-indigo-50 text-indigo-700 font-medium rounded-lg hover:bg-indigo-100 transition-colors flex items-center justify-center gap-2">
                                    <Download size={18} /> Download EPUB
                                </button>
                                <button className="w-full py-2.5 text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition-colors flex items-center justify-center gap-2">
                                    <Eye size={18} /> Preview HTML
                                </button>
                            </div>
                        </div>

                        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                            <h3 className="font-bold text-slate-800 mb-4">File Info</h3>
                            <div className="space-y-3 text-sm">
                                <div className="flex justify-between">
                                    <span className="text-slate-500">Size</span>
                                    <span className="font-mono text-slate-700">2.4 MB</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-slate-500">Chapter Count</span>
                                    <span className="font-mono text-slate-700">1,402</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-slate-500">Created</span>
                                    <span className="font-mono text-slate-700">2023-10-24</span>
                                </div>
                                <div className="pt-3 border-t border-slate-100">
                                    <span className="text-slate-500 block mb-1">Path</span>
                                    <code className="text-xs bg-slate-100 p-1 rounded block break-all text-slate-600">{book.path}</code>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Right Col: Metadata Editor */}
                    <div className="col-span-12 lg:col-span-8 space-y-6">
                        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                            <h3 className="font-bold text-slate-800 mb-6 flex items-center gap-2">
                                <Edit3 size={18} className="text-indigo-600" /> Metadata
                            </h3>

                            <div className="grid grid-cols-2 gap-6">
                                <div className="col-span-2">
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Book Title</label>
                                    <input type="text" defaultValue={book.title} className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Author</label>
                                    <input type="text" defaultValue={book.author} className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Series & Index</label>
                                    <input type="text" defaultValue={book.series} className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" />
                                </div>
                                <div className="col-span-2">
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                                    <textarea rows={4} className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="Book description..."></textarea>
                                </div>
                            </div>
                        </div>

                        {/* TOC Preview (Mini) */}
                        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex-1">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="font-bold text-slate-800">Structure Preview</h3>
                                <button className="text-sm text-indigo-600 font-medium hover:underline">View Full TOC</button>
                            </div>
                            <div className="border border-slate-100 rounded-lg overflow-hidden">
                                {[1, 2, 3, 4, 5].map(i => (
                                    <div key={i} className="px-4 py-3 border-b border-slate-100 last:border-0 text-sm flex justify-between hover:bg-slate-50">
                                        <span className="text-slate-700">Chapter {i}: The {['Beginning', 'Journey', 'Conflict', 'Resolution', 'End'][i - 1]}</span>
                                        <span className="text-slate-400 font-mono text-xs">Page {i * 12}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
};

// 7. Rules Page (Split Pane)
const RulesPage = () => {
    return (
        <div className="h-full flex flex-col bg-slate-50">
            <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
                <h2 className="text-xl font-bold text-slate-800">Rule Engine</h2>
                <div className="flex gap-2">
                    <button className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700">Save Rule</button>
                </div>
            </header>

            <div className="flex-1 flex overflow-hidden">
                {/* Sidebar List */}
                <div className="w-64 bg-white border-r border-slate-200 overflow-y-auto">
                    {MOCK_RULES.map(rule => (
                        <div key={rule.id} className={`p-4 border-b border-slate-100 cursor-pointer hover:bg-slate-50 ${rule.id === 'r1' ? 'bg-indigo-50 border-r-4 border-r-indigo-600' : ''}`}>
                            <h3 className={`font-bold text-sm ${rule.id === 'r1' ? 'text-indigo-900' : 'text-slate-700'}`}>{rule.name}</h3>
                            <p className="text-xs text-slate-500 mt-1 line-clamp-2">{rule.description}</p>
                        </div>
                    ))}
                    <div className="p-4">
                        <button className="w-full py-2 border border-dashed border-slate-300 rounded-lg text-slate-500 text-sm hover:border-indigo-400 hover:text-indigo-600 transition-colors">
                            + New Rule
                        </button>
                    </div>
                </div>

                {/* Editor Area */}
                <div className="flex-1 flex flex-col min-w-0">
                    {/* Split View */}
                    <div className="flex-1 flex">
                        {/* Left: JSON Editor */}
                        <div className="flex-1 bg-slate-900 text-slate-300 p-0 flex flex-col border-r border-slate-700">
                            <div className="px-4 py-2 bg-slate-800 text-xs font-mono text-slate-400 border-b border-slate-700 flex justify-between">
                                <span>CONFIG (JSON/YAML)</span>
                            </div>
                            <textarea
                                className="flex-1 w-full bg-slate-900 text-sm font-mono p-4 outline-none resize-none leading-relaxed text-green-400"
                                spellCheck="false"
                                defaultValue={`{
  "name": "General Web Novel",
  "structure": {
    "volume": "^第[0-9一二三四五六七八九十百千万]+卷\\s+.*$",
    "chapter": "^第[0-9一二三四五六七八九十百千万]+章\\s+.*$"
  },
  "cleanup": [
    { "replace": "(&nbsp;)", "with": " " },
    { "remove": "^PS:.*" }
  ],
  "title_extract": {
    "method": "first_line_if_short"
  }
}`}
                            ></textarea>
                        </div>

                        {/* Right: Test Playground */}
                        <div className="flex-1 bg-white flex flex-col min-w-0">
                            <div className="px-4 py-2 bg-slate-100 text-xs font-bold text-slate-600 border-b border-slate-200 flex justify-between items-center">
                                <span>TEST PLAYGROUND (PASTE TXT)</span>
                                <span className="text-green-600 flex items-center gap-1"><CheckCircle2 size={12} /> Valid JSON</span>
                            </div>

                            <div className="flex-1 p-4 overflow-y-auto font-mono text-sm leading-relaxed whitespace-pre-wrap text-slate-800">
                                <span className="text-slate-400">{'// Paste text here to test regex matches'}</span>
                                <br /><br />
                                <span className="bg-indigo-100 text-indigo-800 font-bold px-1 rounded mx-[-4px]">第1卷 初始之地</span>
                                <br /><br />
                                这是一个普通的段落，不会被识别。<br />
                                有些行可能包含广告。<br />
                                <br />
                                <span className="bg-green-100 text-green-800 font-bold px-1 rounded mx-[-4px]">第1章 穿越</span>
                                <br /><br />
                                主角醒来的时候，发现自己在一个陌生的地方。<br />
                                <span className="bg-red-50 text-slate-400 line-through">PS: 求推荐票！</span>
                                <br />
                                <span className="bg-green-100 text-green-800 font-bold px-1 rounded mx-[-4px]">第2章 系统觉醒</span>
                                <br /><br />
                                "叮！系统已绑定。"
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};


// Main App Container
export default function App() {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [activeTab, setActiveTab] = useState('library');
    const [selectedBook, setSelectedBook] = useState(null);

    // Fake router/nav logic
    const renderContent = () => {
        if (selectedBook) {
            return <BookDetailPage book={selectedBook} onBack={() => setSelectedBook(null)} />;
        }

        switch (activeTab) {
            case 'library': return <LibraryPage onSelectBook={(book) => setSelectedBook(book)} />;
            case 'upload': return <UploadPage />;
            case 'jobs': return <JobsPage onGoToBook={() => { setActiveTab('library'); setSelectedBook(MOCK_BOOKS[0]); }} />;
            case 'rules': return <RulesPage />;
            default: return <LibraryPage />;
        }
    };

    // REMOVED BookOpenIcon from here, it is now defined at the top scope

    if (!isAuthenticated) {
        return <AuthPage onLogin={() => setIsAuthenticated(true)} />;
    }

    return (
        <div className="flex h-screen w-screen overflow-hidden font-sans text-slate-900 bg-slate-50">
            <Sidebar
                activeTab={activeTab}
                onTabChange={(tab) => { setActiveTab(tab); setSelectedBook(null); }}
                onLogout={() => setIsAuthenticated(false)}
            />
            <main className="flex-1 h-full min-w-0 flex flex-col relative">
                {renderContent()}
            </main>
        </div>
    );
}