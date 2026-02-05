import React, { useState, useEffect, useMemo } from 'react';
import {
    Book, UploadCloud, Activity, Settings, LogOut, LayoutGrid, List as ListIcon,
    Search, MoreVertical, Download, Edit3, RefreshCw, Trash2, FileText,
    AlertCircle, CheckCircle, Clock, ChevronRight, Save, X, Eye, Code,
    FileType, Layers, Terminal
} from 'lucide-react';

/**
 * MOCK DATA & CONSTANTS
 */
const STATUS_COLORS = {
    synced: 'bg-green-100 text-green-700 border-green-200',
    pending: 'bg-amber-100 text-amber-700 border-amber-200',
    failed: 'bg-red-100 text-red-700 border-red-200',
    processing: 'bg-blue-100 text-blue-700 border-blue-200',
};

const MOCK_BOOKS = [
    {
        id: 'b-1001',
        title: '深空彼岸',
        author: '辰东',
        series: '网络版',
        cover: 'https://via.placeholder.com/300x450/1e293b/ffffff?text=Deep+Space',
        format: 'EPUB',
        size: '4.2 MB',
        status: 'synced', // synced, pending, failed
        addedAt: '2023-10-24T10:00:00',
        path: '/library/chendong/shenkong.epub',
        desc: '浩瀚的宇宙中，一片死寂...',
    },
    {
        id: 'b-1002',
        title: '诡秘之主',
        author: '爱潜水的乌贼',
        series: '精修版',
        cover: 'https://via.placeholder.com/300x450/4f46e5/ffffff?text=LOTM',
        format: 'EPUB',
        size: '8.5 MB',
        status: 'pending', // metadata updated but not written to file
        addedAt: '2023-10-25T14:30:00',
        path: '/library/wuzei/guimi.epub',
        desc: '周明瑞醒来...',
    },
    {
        id: 'b-1003',
        title: 'Raw Text Conversion Error Log',
        author: 'Unknown',
        series: '',
        cover: null,
        format: 'TXT',
        size: '12 KB',
        status: 'failed',
        addedAt: '2023-10-26T09:15:00',
        path: '/incoming/error_dump.txt',
        desc: '',
    }
];

const MOCK_JOBS = [
    { id: 'j-5521', type: 'convert', bookTitle: '道诡异仙', status: 'running', progress: 45, stage: 'Generating EPUB Structure', error: null },
    { id: 'j-5520', type: 'metadata', bookTitle: '深空彼岸', status: 'success', progress: 100, stage: 'Completed', error: null },
    { id: 'j-5519', type: 'convert', bookTitle: 'Test File 01', status: 'failed', progress: 12, stage: 'Parsing TOC', error: 'Regex mismatch at line 402: Chapter title exceeds length limit.' },
];

const MOCK_RULES = [
    { id: 'r-1', name: '通用网文 (General Webnovel)', type: 'regex', version: 'v1.2' },
    { id: 'r-2', name: '出版物标准 (Published)', type: 'regex', version: 'v2.0' },
    { id: 'r-3', name: 'Kindle 优化 CSS', type: 'css', version: 'v1.0' },
];

/**
 * COMPONENTS
 */

// --- Status Badge ---
const StatusBadge = ({ status }) => {
    const config = {
        synced: { label: '已写回', color: STATUS_COLORS.synced, icon: CheckCircle },
        pending: { label: '待写回', color: STATUS_COLORS.pending, icon: Clock },
        failed: { label: '失败', color: STATUS_COLORS.failed, icon: AlertCircle },
        processing: { label: '处理中', color: STATUS_COLORS.processing, icon: Activity },
    };
    const current = config[status] || config.synced;
    const Icon = current.icon;

    return (
        <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${current.color}`}>
            <Icon size={12} />
            {current.label}
        </span>
    );
};

// --- Auth View ---
const AuthView = ({ onLogin }) => {
    const [password, setPassword] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        if (password.length > 0) onLogin();
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50">
            <div className="w-full max-w-sm p-8 bg-white rounded-xl shadow-lg border border-slate-100">
                <div className="flex justify-center mb-6">
                    <div className="w-12 h-12 bg-indigo-600 rounded-lg flex items-center justify-center">
                        <Book className="text-white" size={24} />
                    </div>
                </div>
                <h2 className="text-2xl font-bold text-center text-slate-800 mb-2">Bindery</h2>
                <p className="text-center text-slate-500 mb-8 text-sm">Access Control</p>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="Enter Password"
                            className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                            autoFocus
                        />
                    </div>
                    <button
                        type="submit"
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 rounded-lg transition-colors"
                    >
                        Unlock Library
                    </button>
                </form>
            </div>
        </div>
    );
};

// --- Library View ---
const LibraryView = ({ onNavigate }) => {
    const [viewMode, setViewMode] = useState('grid'); // grid | list
    const [filter, setFilter] = useState('');
    const [sortBy, setSortBy] = useState('recent'); // recent | modified

    const filteredBooks = MOCK_BOOKS.filter(b =>
        b.title.toLowerCase().includes(filter.toLowerCase()) ||
        b.author.toLowerCase().includes(filter.toLowerCase())
    );

    return (
        <div className="space-y-6">
            {/* Toolbar */}
            <div className="flex flex-col md:flex-row gap-4 justify-between items-start md:items-center bg-white p-4 rounded-xl shadow-sm border border-slate-200">
                <div className="relative w-full md:w-96">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <input
                        type="text"
                        placeholder="Search title, author..."
                        className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                    />
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto">
                    <select
                        className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none"
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value)}
                    >
                        <option value="recent">最近导入</option>
                        <option value="modified">最近修改</option>
                    </select>

                    <div className="flex bg-slate-100 p-1 rounded-lg border border-slate-200">
                        <button
                            onClick={() => setViewMode('grid')}
                            className={`p-1.5 rounded ${viewMode === 'grid' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-500 hover:text-slate-700'}`}
                        >
                            <LayoutGrid size={18} />
                        </button>
                        <button
                            onClick={() => setViewMode('list')}
                            className={`p-1.5 rounded ${viewMode === 'list' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-500 hover:text-slate-700'}`}
                        >
                            <ListIcon size={18} />
                        </button>
                    </div>
                </div>
            </div>

            {/* Grid View */}
            {viewMode === 'grid' && (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                    {filteredBooks.map(book => (
                        <div key={book.id} className="group bg-white rounded-xl shadow-sm hover:shadow-md border border-slate-200 overflow-hidden transition-all flex flex-col">
                            <div className="relative aspect-[2/3] bg-slate-100 overflow-hidden cursor-pointer" onClick={() => onNavigate('detail', book)}>
                                {book.cover ? (
                                    <img src={book.cover} alt={book.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                                ) : (
                                    <div className="w-full h-full flex flex-col items-center justify-center text-slate-400 p-4 text-center">
                                        <Book size={48} className="mb-2 opacity-50" />
                                        <span className="text-xs font-mono">{book.title}</span>
                                    </div>
                                )}
                                {/* Overlay Quick Actions */}
                                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-3 p-4 backdrop-blur-[2px]">
                                    <button className="flex items-center gap-2 text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-full text-sm font-medium w-full justify-center">
                                        <Download size={16} /> EPUB
                                    </button>
                                    <button onClick={(e) => { e.stopPropagation(); onNavigate('detail', book); }} className="flex items-center gap-2 text-white bg-slate-600 hover:bg-slate-700 px-4 py-2 rounded-full text-sm font-medium w-full justify-center">
                                        <Edit3 size={16} /> Edit
                                    </button>
                                </div>
                            </div>

                            <div className="p-4 flex-1 flex flex-col">
                                <div className="flex justify-between items-start mb-1">
                                    <h3 className="font-semibold text-slate-900 truncate pr-2" title={book.title}>{book.title}</h3>
                                    <StatusBadge status={book.status} />
                                </div>
                                <p className="text-sm text-slate-500 mb-2 truncate">{book.author || 'Unknown'}</p>
                                <div className="mt-auto pt-3 border-t border-slate-100 flex justify-between items-center text-xs text-slate-400 font-mono">
                                    <span className="truncate max-w-[100px]" title={book.id}>{book.id}</span>
                                    <span>{book.size}</span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* List View */}
            {viewMode === 'list' && (
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                    <table className="w-full text-left border-collapse">
                        <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-500 font-semibold">
                            <tr>
                                <th className="px-6 py-4">Title / Author</th>
                                <th className="px-6 py-4">Path / ID</th>
                                <th className="px-6 py-4">Status</th>
                                <th className="px-6 py-4 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {filteredBooks.map(book => (
                                <tr key={book.id} className="hover:bg-slate-50/50 transition-colors">
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-4">
                                            <div className="w-10 h-14 bg-slate-200 rounded shadow-sm flex-shrink-0 overflow-hidden">
                                                {book.cover && <img src={book.cover} className="w-full h-full object-cover" />}
                                            </div>
                                            <div>
                                                <div
                                                    className="font-medium text-slate-900 cursor-pointer hover:text-indigo-600"
                                                    onClick={() => onNavigate('detail', book)}
                                                >
                                                    {book.title}
                                                </div>
                                                <div className="text-sm text-slate-500">{book.author}</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="text-xs font-mono text-slate-500 bg-slate-100 inline-block px-2 py-1 rounded max-w-[200px] truncate" title={book.path}>
                                            {book.path}
                                        </div>
                                        <div className="text-xs text-slate-400 mt-1">{book.id}</div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <StatusBadge status={book.status} />
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            <button className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors" title="Download">
                                                <Download size={18} />
                                            </button>
                                            <button
                                                className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                                                title="Edit"
                                                onClick={() => onNavigate('detail', book)}
                                            >
                                                <Edit3 size={18} />
                                            </button>
                                            <button className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors" title="Regenerate">
                                                <RefreshCw size={18} />
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
    );
};

// --- Upload View ---
const UploadView = () => {
    const [dragActive, setDragActive] = useState(false);
    const [files, setFiles] = useState([]);
    const [previewData, setPreviewData] = useState(null);

    const handleDrag = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
        else if (e.type === "dragleave") setDragActive(false);
    };

    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            setFiles([...files, ...Array.from(e.dataTransfer.files)]);
            // Simulate preview for the first file
            setTimeout(() => {
                setPreviewData({
                    tocCount: 124,
                    firstChapters: ['Chapter 1: The Beginning', 'Chapter 2: The Crash', 'Chapter 3: Survival'],
                    detectedMeta: { title: 'Uploaded Novel', author: 'Anonymous' },
                    outputPath: '/library/anonymous/uploaded_novel.epub'
                });
            }, 800);
        }
    };

    return (
        <div className="max-w-4xl mx-auto space-y-8">
            {/* Drag Drop Zone */}
            <div
                className={`relative border-2 border-dashed rounded-xl p-12 text-center transition-all ${dragActive ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 hover:border-indigo-400 bg-white'}`}
                onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}
            >
                <div className="flex flex-col items-center gap-4">
                    <div className="w-16 h-16 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center">
                        <UploadCloud size={32} />
                    </div>
                    <div>
                        <h3 className="text-lg font-semibold text-slate-800">Drag & Drop TXT/EPUB files</h3>
                        <p className="text-slate-500 mt-1">or click to browse local files</p>
                    </div>
                </div>
                <input type="file" className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" multiple />
            </div>

            {files.length > 0 && (
                <div className="grid md:grid-cols-2 gap-8">
                    {/* File Config */}
                    <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                        <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
                            <Settings size={18} /> Ingest Configuration
                        </h3>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Rule Template</label>
                                <select className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white">
                                    <option>General Webnovel (v1.2)</option>
                                    <option>Published Standard (v2.0)</option>
                                    <option>Custom...</option>
                                </select>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Title</label>
                                    <input type="text" className="w-full px-3 py-2 border border-slate-300 rounded-lg" placeholder="Auto-detect" defaultValue={previewData?.detectedMeta.title} />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Author</label>
                                    <input type="text" className="w-full px-3 py-2 border border-slate-300 rounded-lg" placeholder="Auto-detect" defaultValue={previewData?.detectedMeta.author} />
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Series</label>
                                <input type="text" className="w-full px-3 py-2 border border-slate-300 rounded-lg" placeholder="Optional" />
                            </div>
                        </div>
                    </div>

                    {/* Preview Panel */}
                    <div className="bg-slate-50 p-6 rounded-xl border border-slate-200">
                        <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
                            <Eye size={18} /> Conversion Preview
                        </h3>
                        {previewData ? (
                            <div className="space-y-4 text-sm">
                                <div className="flex justify-between p-3 bg-white rounded border border-slate-200">
                                    <span className="text-slate-500">Output Path</span>
                                    <span className="font-mono text-slate-700 truncate max-w-[200px]">{previewData.outputPath}</span>
                                </div>
                                <div className="flex justify-between p-3 bg-white rounded border border-slate-200">
                                    <span className="text-slate-500">Detected Chapters</span>
                                    <span className="font-bold text-indigo-600">{previewData.tocCount}</span>
                                </div>
                                <div className="bg-white rounded border border-slate-200 p-3">
                                    <div className="text-xs font-semibold text-slate-400 uppercase mb-2">TOC Sample</div>
                                    <ul className="space-y-1 text-slate-600 font-mono text-xs">
                                        {previewData.firstChapters.map((c, i) => (
                                            <li key={i}>{c}</li>
                                        ))}
                                        <li className="text-slate-400 italic">... and 121 more</li>
                                    </ul>
                                </div>
                                <button className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-lg transition-colors shadow-sm">
                                    Start Processing
                                </button>
                            </div>
                        ) : (
                            <div className="h-40 flex items-center justify-center text-slate-400 italic">
                                Analyzing file content...
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

// --- Jobs View ---
const JobsView = () => {
    return (
        <div className="max-w-5xl mx-auto">
            <div className="flex gap-4 mb-6 border-b border-slate-200 pb-1">
                <button className="px-4 py-2 text-indigo-600 border-b-2 border-indigo-600 font-medium">All Jobs</button>
                <button className="px-4 py-2 text-slate-500 hover:text-slate-800">Running (1)</button>
                <button className="px-4 py-2 text-slate-500 hover:text-slate-800">Failed (1)</button>
            </div>

            <div className="space-y-4">
                {MOCK_JOBS.map(job => (
                    <div key={job.id} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
                        <div className="flex justify-between items-start mb-4">
                            <div className="flex items-center gap-3">
                                <div className={`w-2 h-2 rounded-full ${job.status === 'running' ? 'bg-blue-500 animate-pulse' : job.status === 'success' ? 'bg-green-500' : 'bg-red-500'}`}></div>
                                <div>
                                    <h4 className="font-semibold text-slate-900">{job.bookTitle}</h4>
                                    <div className="text-xs text-slate-500 font-mono uppercase mt-0.5">{job.type} • {job.id}</div>
                                </div>
                            </div>
                            <div className="flex gap-2">
                                {job.status === 'failed' && (
                                    <button className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 flex items-center gap-1">
                                        <RefreshCw size={12} /> Retry
                                    </button>
                                )}
                                {job.status === 'success' && (
                                    <button className="px-3 py-1.5 text-xs font-medium bg-indigo-50 text-indigo-700 rounded-lg hover:bg-indigo-100 flex items-center gap-1">
                                        View Book <ChevronRight size={12} />
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Progress Bar */}
                        <div className="mb-2">
                            <div className="flex justify-between text-xs mb-1">
                                <span className="font-medium text-slate-700">{job.stage}</span>
                                <span className="text-slate-500">{job.progress}%</span>
                            </div>
                            <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                                <div
                                    className={`h-full rounded-full ${job.status === 'failed' ? 'bg-red-500' : job.status === 'success' ? 'bg-green-500' : 'bg-indigo-500'}`}
                                    style={{ width: `${job.progress}%` }}
                                ></div>
                            </div>
                        </div>

                        {/* Error Log */}
                        {job.error && (
                            <div className="mt-4 bg-red-50 border border-red-100 rounded-lg p-3">
                                <div className="flex items-start gap-2">
                                    <AlertCircle size={16} className="text-red-600 mt-0.5 flex-shrink-0" />
                                    <div className="flex-1">
                                        <p className="text-sm text-red-800 font-medium">Processing Failed</p>
                                        <p className="text-xs text-red-600 font-mono mt-1">{job.error}</p>
                                        <button className="text-xs text-red-700 underline mt-2 hover:text-red-900">Show Full Stderr</button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};

// --- Book Detail View ---
const BookDetailView = ({ book, onBack }) => {
    return (
        <div className="max-w-6xl mx-auto animate-in fade-in zoom-in-95 duration-200">
            <button onClick={onBack} className="flex items-center text-sm text-slate-500 hover:text-indigo-600 mb-4 transition-colors">
                <ChevronRight size={16} className="rotate-180" /> Back to Library
            </button>

            <div className="grid lg:grid-cols-12 gap-8">
                {/* Left Column: Cover & Actions */}
                <div className="lg:col-span-4 space-y-6">
                    <div className="relative group rounded-xl overflow-hidden shadow-md border border-slate-200 bg-slate-100 aspect-[2/3]">
                        {book.cover ? (
                            <img src={book.cover} alt="Cover" className="w-full h-full object-cover" />
                        ) : (
                            <div className="flex items-center justify-center w-full h-full">No Cover</div>
                        )}
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <button className="bg-white/90 text-slate-900 px-4 py-2 rounded-full font-medium text-sm hover:bg-white flex items-center gap-2">
                                <UploadCloud size={16} /> Change Cover
                            </button>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <button className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-lg font-medium flex items-center justify-center gap-2 transition-colors">
                            <Download size={18} /> Download EPUB
                        </button>
                        <button className="w-full bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 py-3 rounded-lg font-medium flex items-center justify-center gap-2 transition-colors">
                            <RefreshCw size={18} /> Regenerate
                        </button>
                        <button className="w-full bg-white border border-red-200 text-red-600 hover:bg-red-50 py-3 rounded-lg font-medium flex items-center justify-center gap-2 transition-colors">
                            <Trash2 size={18} /> Archive / Delete
                        </button>
                    </div>
                </div>

                {/* Right Column: Metadata & TOC */}
                <div className="lg:col-span-8 space-y-8">
                    {/* Metadata Form */}
                    <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-xl font-bold text-slate-900">Metadata</h2>
                            <div className="flex gap-2">
                                <button className="px-4 py-2 text-sm bg-indigo-50 text-indigo-700 rounded-lg hover:bg-indigo-100 font-medium flex items-center gap-2">
                                    <Save size={16} /> Save & Write to File
                                </button>
                            </div>
                        </div>

                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="space-y-1">
                                <label className="text-xs font-semibold text-slate-500 uppercase">Title</label>
                                <input type="text" defaultValue={book.title} className="w-full p-2 border border-slate-300 rounded focus:ring-2 focus:ring-indigo-500 outline-none font-medium" />
                            </div>
                            <div className="space-y-1">
                                <label className="text-xs font-semibold text-slate-500 uppercase">Author</label>
                                <input type="text" defaultValue={book.author} className="w-full p-2 border border-slate-300 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
                            </div>
                            <div className="space-y-1">
                                <label className="text-xs font-semibold text-slate-500 uppercase">Series</label>
                                <input type="text" defaultValue={book.series} className="w-full p-2 border border-slate-300 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
                            </div>
                            <div className="space-y-1">
                                <label className="text-xs font-semibold text-slate-500 uppercase">Identifier</label>
                                <input type="text" defaultValue={book.id} disabled className="w-full p-2 border border-slate-200 bg-slate-50 rounded text-slate-500" />
                            </div>
                            <div className="md:col-span-2 space-y-1">
                                <label className="text-xs font-semibold text-slate-500 uppercase">Description</label>
                                <textarea defaultValue={book.desc} rows={4} className="w-full p-2 border border-slate-300 rounded focus:ring-2 focus:ring-indigo-500 outline-none text-sm leading-relaxed"></textarea>
                            </div>
                        </div>
                    </div>

                    {/* TOC Preview */}
                    <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                        <h2 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                            <ListIcon size={20} /> Structure Preview
                        </h2>
                        <div className="border border-slate-100 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                            {[1, 2, 3, 4, 5, 6].map(i => (
                                <div key={i} className="flex justify-between items-center px-4 py-3 border-b border-slate-100 last:border-0 hover:bg-slate-50">
                                    <span className="text-sm text-slate-700">Chapter {i}: The Journey Begins</span>
                                    <span className="text-xs text-slate-400 font-mono">2.4kb</span>
                                </div>
                            ))}
                            <div className="px-4 py-3 text-xs text-slate-400 text-center italic bg-slate-50">
                                + 1,402 more items
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// --- Rules View ---
const RulesView = () => {
    return (
        <div className="h-[calc(100vh-140px)] flex flex-col lg:flex-row gap-6">
            {/* Sidebar: Rules List */}
            <div className="w-full lg:w-64 flex-shrink-0 bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden">
                <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
                    <span className="font-semibold text-slate-700">Templates</span>
                    <button className="text-indigo-600 hover:text-indigo-800"><Layers size={18} /></button>
                </div>
                <div className="overflow-y-auto flex-1 p-2 space-y-1">
                    {MOCK_RULES.map(rule => (
                        <button key={rule.id} className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center justify-between group ${rule.id === 'r-1' ? 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200' : 'text-slate-600 hover:bg-slate-50'}`}>
                            <span className="truncate">{rule.name}</span>
                            <span className="text-[10px] bg-white border border-slate-200 px-1.5 py-0.5 rounded text-slate-400">{rule.version}</span>
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-slate-200">
                    <button className="w-full py-2 bg-indigo-600 text-white text-xs font-bold rounded-lg hover:bg-indigo-700">
                        + New Template
                    </button>
                </div>
            </div>

            {/* Main: Editor & Test Bench */}
            <div className="flex-1 flex flex-col gap-4">
                {/* Editor Toolbar */}
                <div className="bg-white border border-slate-200 rounded-xl p-3 flex justify-between items-center">
                    <div className="flex gap-4 items-center">
                        <h3 className="font-bold text-slate-800 px-2">General Webnovel</h3>
                        <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded border border-green-200">Production Ready</span>
                    </div>
                    <button className="flex items-center gap-2 px-4 py-2 bg-slate-800 text-white text-sm rounded-lg hover:bg-slate-900">
                        <Save size={16} /> Save Version
                    </button>
                </div>

                {/* Workbench Split View */}
                <div className="flex-1 grid grid-cols-2 gap-4 min-h-0">
                    {/* Regex/Config Input */}
                    <div className="bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden">
                        <div className="bg-slate-100 px-4 py-2 border-b border-slate-200 text-xs font-mono text-slate-500 flex justify-between">
                            <span>CONFIG JSON</span>
                            <span>REGEX MODE</span>
                        </div>
                        <textarea
                            className="flex-1 w-full p-4 font-mono text-sm resize-none focus:outline-none text-slate-700"
                            defaultValue={`{
  "chapter_regex": "^第[0-9一二三四五六七八九十百千]+[章卷].*",
  "noise_filters": [
    "更多更新请访问.*",
    "PS:.*"
  ],
  "hierarchy": ["volume", "chapter"],
  "min_line_length": 5
}`}
                        ></textarea>
                    </div>

                    {/* Live Test */}
                    <div className="bg-slate-800 border border-slate-700 rounded-xl flex flex-col overflow-hidden shadow-inner">
                        <div className="bg-slate-900 px-4 py-2 border-b border-slate-700 text-xs font-mono text-slate-400 flex justify-between items-center">
                            <span>TEST BENCH (PASTE TXT HERE)</span>
                            <div className="flex gap-2">
                                <span className="flex items-center gap-1 text-green-400"><div className="w-2 h-2 bg-green-500 rounded-full"></div> 12 Matches</span>
                            </div>
                        </div>
                        <div className="flex-1 relative font-mono text-sm p-4 overflow-y-auto bg-slate-800 text-slate-400 whitespace-pre-wrap">
                            {/* Simulated Highlighting */}
                            <span className="bg-indigo-500/30 text-indigo-100 px-1 rounded block mb-2">第1章 穿越开始</span>
                            <p className="mb-4">Here is some normal text that is part of the content body...</p>
                            <span className="bg-indigo-500/30 text-indigo-100 px-1 rounded block mb-2">第2章 系统觉醒</span>
                            <p className="mb-4">More content here...</p>
                            <span className="bg-red-500/20 text-red-200 px-1 rounded block mb-2 line-through opacity-70">PS: 求推荐票</span>
                            <p>End of sample.</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// --- Main App Shell ---
const App = () => {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [currentView, setCurrentView] = useState('library'); // library, upload, jobs, detail, rules
    const [selectedBook, setSelectedBook] = useState(null);

    const navigate = (view, data = null) => {
        if (data) setSelectedBook(data);
        setCurrentView(view);
    };

    if (!isAuthenticated) return <AuthView onLogin={() => setIsAuthenticated(true)} />;

    return (
        <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
            {/* Top Navigation Bar */}
            <nav className="sticky top-0 z-50 bg-white border-b border-slate-200 shadow-sm h-16">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-full flex items-center justify-between">
                    <div className="flex items-center gap-8">
                        <div className="flex items-center gap-2 font-bold text-xl text-indigo-600">
                            <Book className="fill-indigo-600" size={24} strokeWidth={1.5} />
                            <span className="text-slate-800 tracking-tight">Bindery</span>
                        </div>

                        <div className="hidden md:flex items-center space-x-1">
                            {[
                                { id: 'library', label: 'Library', icon: LayoutGrid },
                                { id: 'upload', label: 'Ingest', icon: UploadCloud },
                                { id: 'jobs', label: 'Jobs', icon: Activity },
                                { id: 'rules', label: 'Rules', icon: Code },
                            ].map(item => (
                                <button
                                    key={item.id}
                                    onClick={() => navigate(item.id)}
                                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${currentView === item.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-50'}`}
                                >
                                    <item.icon size={18} />
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex items-center gap-4">
                        {/* Simulated Job Indicator */}
                        <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-slate-100 rounded-full border border-slate-200 text-xs font-medium text-slate-600 cursor-pointer hover:bg-slate-200" onClick={() => navigate('jobs')}>
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            Processing 1 item
                        </div>

                        <button onClick={() => setIsAuthenticated(false)} className="text-slate-400 hover:text-red-500 transition-colors">
                            <LogOut size={20} />
                        </button>
                    </div>
                </div>
            </nav>

            {/* Main Content Area */}
            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {currentView === 'library' && <LibraryView onNavigate={navigate} />}
                {currentView === 'upload' && <UploadView />}
                {currentView === 'jobs' && <JobsView />}
                {currentView === 'rules' && <RulesView />}
                {currentView === 'detail' && selectedBook && <BookDetailView book={selectedBook} onBack={() => navigate('library')} />}
            </main>
        </div>
    );
};

export default App;