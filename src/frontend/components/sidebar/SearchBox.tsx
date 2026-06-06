import React, { useState } from 'react';

interface SearchBoxProps {
  onSearch: (query: string) => void;
}

export const SearchBox: React.FC<SearchBoxProps> = ({ onSearch }) => {
  const [inputValue, setInputValue] = useState('');

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onSearch(inputValue.trim());
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInputValue(val);
    if (val === '') {
      onSearch(''); // 清空时立即恢复全量列表
    }
  };

  return (
    <div className="px-4 py-3 border-b border-gray-700">
      <input
        type="text"
        value={inputValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="搜索对话 (Enter触发)..."
        className="w-full bg-gray-800 text-gray-200 text-sm rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500 transition-all"
      />
    </div>
  );
};